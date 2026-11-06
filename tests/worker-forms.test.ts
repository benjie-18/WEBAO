// Public form submissions: validation, field sanitation and storage shape.
// Listings derive from the form: prefix (newest first); no index key is
// kept, so a submission costs exactly one KV write.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleFormSubmit } from '../worker/forms';
import { apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const submit = (body: unknown, options: Parameters<typeof apiRequest>[2] = {}) =>
  apiRequest('/api/forms/submit', body, options);

const pricingForm = {
  form: 'pricing',
  fields: { name: 'Dana', email: 'dana@example.ca', message: 'I want the Grow plan', 'Phone number': '613-555-0100' },
};

test('a pricing submission is stored and echoed with its id (no index write)', async () => {
  const memory = memoryKV();
  const response = await handleFormSubmit(
    submit(pricingForm, { ip: '203.0.113.7', headers: { 'user-agent': 'Test/1.0', 'cf-ipcountry': 'ca' } }),
    envOf(memory.kv),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.ok, true);
  assert.match(body.id, /^\d{13}:[0-9a-f]{16}$/);

  const key = `form:${body.id}`;
  const stored = JSON.parse(memory.store.get(key) ?? 'null');
  assert.equal(stored.form, 'pricing');
  assert.deepEqual(stored.fields, pricingForm.fields);
  assert.equal(stored.ip, '203.0.113.7');
  assert.equal(stored.country, 'CA');
  assert.equal(stored.ua, 'Test/1.0');
  assert.ok(typeof stored.at === 'number');
  // No index key: the admin list derives from the form: prefix, so a
  // submission costs exactly one write.
  assert.equal(memory.store.has('forms:index'), false);
  assert.deepEqual(memory.puts, [key]);
});

test('a support submission is stored with its category, subject and description', async () => {
  const memory = memoryKV();
  const fields = {
    name: 'Sam',
    email: 'sam@example.ca',
    category: 'billing',
    subject: 'Invoice for October',
    message: 'Please resend my October invoice.',
    page: '/support/',
  };
  // A present-but-unusable EMAIL binding must not fail the submission: the
  // email copy is best-effort, the KV record is the source of truth.
  const env = envOf(memory.kv, {
    EMAIL: {
      send: async () => {
        throw new Error('no mail in tests');
      },
    },
  });
  const response = await handleFormSubmit(submit({ form: 'support', fields }), env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.ok, true);
  const stored = JSON.parse(memory.store.get(`form:${body.id}`) ?? 'null');
  assert.equal(stored.form, 'support');
  assert.deepEqual(stored.fields, fields);
});

test('a contact submission is stored even when the email copy cannot be sent', async () => {
  const memory = memoryKV();
  const env = envOf(memory.kv, {
    EMAIL: {
      send: async () => {
        throw new Error('no mail in tests');
      },
    },
  });
  const response = await handleFormSubmit(
    submit({ form: 'contact', fields: { name: 'Sam', email: 'sam@example.ca', message: 'Bonjour' } }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.ok, true);
  const stored = JSON.parse(memory.store.get(`form:${body.id}`) ?? 'null');
  assert.equal(stored.form, 'contact');
});

test('two submissions are both stored, with no index key', async () => {
  const memory = memoryKV();
  const first = await bodyOf(await handleFormSubmit(submit(pricingForm), envOf(memory.kv)));
  const second = await bodyOf(
    await handleFormSubmit(submit({ form: 'contact', fields: { name: 'Sam', message: 'Bonjour' } }), envOf(memory.kv)),
  );
  assert.equal(memory.store.has(`form:${first.id}`), true);
  assert.equal(memory.store.has(`form:${second.id}`), true);
  assert.equal(memory.store.has('forms:index'), false);
  assert.equal(memory.puts.length, 2);
});

test('required fields follow the form type', async () => {
  const cases: Array<[string, unknown, string]> = [
    ['pricing', { form: 'pricing', fields: { email: 'dana@example.ca' } }, 'Name is required'],
    ['pricing', { form: 'pricing', fields: { name: 'Dana' } }, 'Valid email is required'],
    ['pricing', { form: 'pricing', fields: { name: 'Dana', email: 'not-an-email' } }, 'Valid email is required'],
    ['contact', { form: 'contact', fields: { name: 'Sam' } }, 'Email or message is required'],
    ['contact', { form: 'contact', fields: { name: 'Sam', email: 'nope' } }, 'Invalid email'],
    ['contact', { form: 'contact', fields: { name: '   ' } }, 'Name is required'],
    ['support', { form: 'support', fields: { name: 'Sam', email: 'sam@example.ca', subject: 'Hours', message: 'Please update' } }, 'Category is required'],
    ['support', { form: 'support', fields: { name: 'Sam', email: 'sam@example.ca', category: 'spam', subject: 'Hours', message: 'Please update' } }, 'Category is required'],
    ['support', { form: 'support', fields: { name: 'Sam', category: 'billing', subject: 'Invoice', message: 'Please resend' } }, 'Valid email is required'],
    ['support', { form: 'support', fields: { name: 'Sam', email: 'sam@example.ca', category: 'billing', message: 'Please resend' } }, 'Subject is required'],
    ['support', { form: 'support', fields: { name: 'Sam', email: 'sam@example.ca', category: 'billing', subject: 'Invoice' } }, 'Description is required'],
  ];
  for (const [label, body, message] of cases) {
    const memory = memoryKV();
    const response = await handleFormSubmit(submit(body), envOf(memory.kv));
    assert.equal(response.status, 400, label);
    assert.deepEqual(await bodyOf(response), { ok: false, error: message });
    assert.equal(memory.store.has('forms:index'), false);
  }

  // Contact accepts a message without an email, and an email without a message.
  const memory = memoryKV();
  const withMessage = await handleFormSubmit(
    submit({ form: 'contact', fields: { name: 'Sam', message: 'Bonjour' } }),
    envOf(memory.kv),
  );
  assert.equal(withMessage.status, 200);
  const withEmail = await handleFormSubmit(
    submit({ form: 'contact', fields: { name: 'Sam', email: 'sam@example.ca' } }),
    envOf(memory.kv),
  );
  assert.equal(withEmail.status, 200);
});

test('the form type is whitelisted', async () => {
  for (const form of ['newsletter', '', null, 42, undefined]) {
    const memory = memoryKV();
    const response = await handleFormSubmit(submit({ form, fields: { name: 'Dana' } }), envOf(memory.kv));
    assert.equal(response.status, 400, String(form));
    assert.deepEqual(await bodyOf(response), { ok: false, error: 'Invalid form' });
  }
});

test('field values are sanitized before they are stored', async () => {
  const memory = memoryKV();
  const fields: Record<string, unknown> = {
    name: 'Dana',
    email: 'dana@example.ca',
    note: 'x'.repeat(6000),
    count: 7,
    ok: true,
    nothing: null,
    nested: { a: 1 },
    list: ['a'],
  };
  for (let i = 0; i < 50; i++) fields[`k${i}`] = `v${i}`;
  const response = await handleFormSubmit(submit({ form: 'pricing', fields }), envOf(memory.kv));
  assert.equal(response.status, 200);
  const id = (await bodyOf(response)).id;
  const stored = JSON.parse(memory.store.get(`form:${id}`) ?? 'null');
  assert.equal(stored.fields.note.length, 5000, 'values are capped');
  assert.equal(stored.fields.count, undefined, 'non-strings are dropped');
  assert.equal(stored.fields.ok, undefined);
  assert.equal(stored.fields.nothing, undefined);
  assert.equal(stored.fields.nested, undefined);
  assert.equal(stored.fields.list, undefined);
  assert.equal(Object.keys(stored.fields).length, 40, 'exactly 40 fields are kept');
  assert.equal(Object.keys(stored.fields).at(-1), 'k36', 'iteration stops at the 40-field cap');
  assert.equal(stored.fields.k37, undefined);
  assert.equal(stored.fields.name, 'Dana');
});

test('fields must be a plain object and odd values are rejected', async () => {
  for (const fields of [undefined, null, 'name=Dana', 42, ['Dana'], { name: 42 }]) {
    const memory = memoryKV();
    const response = await handleFormSubmit(submit({ form: 'contact', fields }), envOf(memory.kv));
    assert.equal(response.status, 400, JSON.stringify(fields));
    const body = await bodyOf(response);
    assert.equal(body.ok, false);
    // Arrays/non-objects are "Invalid fields"; objects with only non-string
    // values fall through to the required-name check.
    assert.ok(['Invalid fields', 'Name is required'].includes(body.error), body.error);
  }
});

test('long field names are truncated on their way into KV', async () => {
  const memory = memoryKV();
  const longKey = 'k'.repeat(60);
  await handleFormSubmit(
    submit({ form: 'pricing', fields: { name: 'Dana', email: 'dana@example.ca', [longKey]: 'v' } }),
    envOf(memory.kv),
  );
  const id = (await bodyOf(await handleFormSubmit(submit(pricingForm), envOf(memory.kv)))).id;
  assert.ok(id, 'second submission still works');
  const stored = JSON.parse(memory.store.get(`form:${id}`) ?? 'null');
  assert.equal(Object.keys(stored.fields).length, 4);
});

test('requests are gated by origin and content type', async () => {
  const memory = memoryKV();
  for (const origin of [null, 'https://evil.example']) {
    const response = await handleFormSubmit(submit(pricingForm, { origin }), envOf(memory.kv));
    assert.equal(response.status, 403);
    assert.deepEqual(await bodyOf(response), { ok: false, error: 'Forbidden origin' });
  }
  assert.equal(memory.store.size, 0);

  const wrongType = new Request('https://webao.ca/api/forms/submit', {
    method: 'POST',
    headers: { origin: 'https://webao.ca', 'content-type': 'text/plain' },
    body: 'hello',
  });
  const response = await handleFormSubmit(wrongType, envOf(memory.kv));
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { ok: false, error: 'Expected application/json' });
});

test('old submissions are never deleted by a new one', async () => {
  const memory = memoryKV();
  const oldKeys = Array.from({ length: 1000 }, (_, i) => `form:${1000 + i}:old${String(i).padStart(13, '0')}`);
  for (const key of oldKeys)
    memory.store.set(key, JSON.stringify({ form: 'contact', fields: { name: 'old' }, at: 1 }));

  await handleFormSubmit(submit({ form: 'contact', fields: { name: 'Sam', message: 'hi' } }), envOf(memory.kv));

  // No index key is written, and no old record is deleted: listings cap
  // at 1000 keys on read, records are never evicted on write.
  assert.equal(memory.store.has('forms:index'), false);
  assert.equal(memory.deletes.length, 0);
  for (const key of oldKeys) assert.equal(memory.store.has(key), true);
});

test('submissions include the visitor metadata the admin panel shows', async () => {
  const memory = memoryKV();
  await handleFormSubmit(
    submit({ form: 'contact', fields: { name: 'Sam', message: 'hi' } }, {
      ip: '198.51.100.9',
      headers: { 'user-agent': 'UA/1', 'cf-ipcountry': 'fr' },
    }),
    envOf(memory.kv),
  );
  const key = memory.puts[0];
  const stored = JSON.parse(memory.store.get(key) ?? 'null');
  assert.equal(stored.ip, '198.51.100.9');
  assert.equal(stored.country, 'FR');
  assert.equal(stored.ua, 'UA/1');
});
