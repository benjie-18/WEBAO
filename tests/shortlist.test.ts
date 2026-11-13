// Demo shortlist (#50): up to 3 slugs in localStorage, unknown slugs
// dropped on read, names resolved from the catalog.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readShortlist, shortlistNames, toggleShortlist, writeShortlist, SHORTLIST_KEY, SHORTLIST_MAX } from '../src/lib/shortlist';

function fakeWindow(initial?: string): { win: Window; store: Record<string, string> } {
  const store: Record<string, string> = {};
  if (initial !== undefined) store[SHORTLIST_KEY] = initial;
  const win = {
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    },
  } as unknown as Window;
  return { win, store };
}

test('an empty store reads as an empty shortlist', () => {
  const { win } = fakeWindow();
  assert.deepEqual(readShortlist(win), []);
});

test('toggle adds then removes the same demo', () => {
  const { win } = fakeWindow();
  assert.deepEqual(toggleShortlist(win, 'nora'), { ids: ['nora'], added: true, full: false });
  assert.deepEqual(toggleShortlist(win, 'nora'), { ids: [], added: false, full: false });
  assert.deepEqual(readShortlist(win), []);
});

test('the shortlist caps at three and the fourth add reports full', () => {
  const { win } = fakeWindow();
  toggleShortlist(win, 'nora');
  toggleShortlist(win, 'mira');
  toggleShortlist(win, 'boreal');
  assert.equal(SHORTLIST_MAX, 3);
  const fourth = toggleShortlist(win, 'leduc');
  assert.deepEqual(fourth, { ids: ['nora', 'mira', 'boreal'], added: false, full: true });
  assert.deepEqual(readShortlist(win), ['nora', 'mira', 'boreal']);
});

test('unknown slugs and duplicates are dropped on read', () => {
  const { win } = fakeWindow(JSON.stringify(['nora', 'no-such-demo', 'nora', 'mira']));
  assert.deepEqual(readShortlist(win), ['nora', 'mira']);
});

test('a corrupt stored value reads as empty instead of throwing', () => {
  const { win } = fakeWindow('not-json{');
  assert.deepEqual(readShortlist(win), []);
});

test('writeShortlist persists and names resolve from the catalog', () => {
  const { win, store } = fakeWindow();
  writeShortlist(win, ['boreal', 'nora']);
  assert.equal(store[SHORTLIST_KEY], JSON.stringify(['boreal', 'nora']));
  const names = shortlistNames(['boreal', 'nora']);
  assert.equal(names.length, 2);
  assert.ok(names.every((name) => typeof name === 'string' && name.length > 0));
});
