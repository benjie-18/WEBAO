// Inbox MIME builder: the single builder every inbox mail path uses
// (mailer, forms, webhook, portal). These tests pin the exact bytes the
// send_email binding would carry, since the binding itself is a
// workerd-only import that cannot resolve under the node test runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import { base64Utf8, buildInboxEmail, encodeHeader, headerSafe, INBOX_ADDRESS } from '../worker/mailer';

test('buildInboxEmail: plain-ASCII headers pass through untouched', () => {
  const raw = buildInboxEmail({
    from: 'start@webao.ca',
    fromName: 'WEBAO',
    subject: 'Build ready for review: Pat Plumbing',
    body: 'Hello,\n\nYour site is ready.',
  });
  assert.match(raw, /^From: "WEBAO" <start@webao\.ca>\r\n/);
  assert.ok(raw.includes(`To: ${INBOX_ADDRESS}`));
  assert.ok(raw.includes('Subject: Build ready for review: Pat Plumbing'));
  assert.ok(raw.includes('MIME-Version: 1.0'));
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.ok(!raw.includes('Reply-To:'));
  const bodyB64 = raw.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(bodyB64, 'base64').toString('utf-8'), 'Hello,\n\nYour site is ready.');
});

test('buildInboxEmail: non-ASCII headers are RFC 2047 encoded, never raw UTF-8', () => {
  const raw = buildInboxEmail({
    from: 'start@webao.ca',
    fromName: 'WEBAO',
    subject: 'Votre site est prêt à réviser',
    body: 'Bonjour',
  });
  const subjectLine = raw.split('\r\n').find((l) => l.startsWith('Subject: '))!;
  assert.match(subjectLine, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(
    Buffer.from(subjectLine.replace(/^Subject: =\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf-8'),
    'Votre site est prêt à réviser',
  );
  assert.ok(!raw.includes('prêt à réviser'), 'no raw non-ASCII in the header block');
});

test('buildInboxEmail: Reply-To is present only when given, and CRLF is stripped', () => {
  const withReply = buildInboxEmail({
    from: 'start@webao.ca',
    fromName: 'WEBAO',
    subject: 'Hi',
    body: 'x',
    replyTo: 'contact+ld_abc@webao.ca',
  });
  assert.ok(withReply.includes('Reply-To: contact+ld_abc@webao.ca'));

  const injected = buildInboxEmail({
    from: 'start@webao.ca',
    fromName: 'WEBAO',
    subject: 'Hi\r\nBcc: victim@example.ca',
    body: 'x',
  });
  // headerSafe flattens the CRLF to a space: the text survives inside the
  // Subject VALUE, but it must never become its own header line.
  assert.ok(!injected.split('\r\n').some((l) => l.startsWith('Bcc:')), 'no injected header line');
  assert.ok(injected.includes('Subject: Hi Bcc: victim@example.ca'));
});

test('encodeHeader and headerSafe: ASCII passthrough, CRLF flattened', () => {
  assert.equal(encodeHeader('Plain subject'), 'Plain subject');
  assert.equal(headerSafe('a\r\nb\nc'), 'a b c');
  assert.equal(encodeHeader('Café'), `=?UTF-8?B?${base64Utf8('Café')}?=`);
});
