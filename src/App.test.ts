import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { invokeNappletIntent } from '@hyprgate/utils';
import { outbox } from '@napplet/sdk';

const SELF = 'a'.repeat(64);
const NAMED = 'b'.repeat(64);
const NAMELESS = 'c'.repeat(64);
const NOTE_ID = 'd'.repeat(64);

vi.mock('@napplet/sdk', () => ({
  common: { encodeNip19: vi.fn(async ({ hex }: { hex: string }) => ({ ok: true, value: `npub1${hex}` })) },
  identity: {
    getPublicKey: vi.fn(async () => SELF),
    getFollows: vi.fn(async () => [NAMED, NAMELESS]),
  },
  outbox: { query: vi.fn() },
  relay: { subscribe: vi.fn(() => ({ close: vi.fn() })) },
}));

vi.mock('@hyprgate/utils', () => ({
  invokeNappletIntent: vi.fn(async () => ({ ok: true, archetype: 'profile', action: 'open' })),
  createProfileIntentRequest: (payload: unknown) => ({ archetype: 'profile', convention: 'napplet:profile/open', payload }),
  createNoteViewerOpenPayload: (payload: unknown) => payload,
  createNoteViewerOpenIntentRequest: (payload: unknown) => ({ archetype: 'note', convention: 'napplet:note/open', payload }),
  pubkeyColorStyle: () => '',
  resourceImageBatch: (node: HTMLImageElement, source: string) => {
    node.dataset.source = source;
    return { destroy() {} };
  },
}));

const event = (id: string, kind: number, pubkey: string, content: string, createdAt = 100) => ({
  event: { id, kind, pubkey, content, created_at: createdAt, tags: [], sig: 's' },
});

describe('People Radar', () => {
  beforeEach(() => {
    (globalThis as unknown as { napplet: unknown }).napplet = {
      shell: { ready: async () => ({}), supports: (domain: string) => domain === 'outbox' },
    };
    vi.mocked(outbox.query).mockImplementation(async (filter) => {
      const kinds = (filter as { kinds?: number[] }).kinds ?? [];
      if (kinds.includes(0)) {
        return { events: [event('meta', 0, NAMED, JSON.stringify({ display_name: 'Ines Okafor', picture: 'https://media.example/ines.png' }))] } as never;
      }
      return { events: [event(NOTE_ID, 1, NAMED, 'hello there', Math.floor(Date.now() / 1000) - 120)] } as never;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    delete (globalThis as unknown as { napplet?: unknown }).napplet;
  });

  const row = (pubkey: string) => document.querySelector<HTMLButtonElement>(`[data-pubkey="${pubkey}"]`);

  it('shows the avatar and name when known, and the npub when there is no profile', async () => {
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(row(NAMED)?.textContent).toContain('Ines Okafor'));
    expect(document.querySelector('img')?.dataset.source).toBe('https://media.example/ines.png');
    await vi.waitFor(() => expect(row(NAMELESS)?.textContent).toContain('npub1cccc'));
    expect(row(NAMELESS)?.getAttribute('title')).toBe(`npub1${NAMELESS}`);
    unmount(component);
  });

  it('opens a profile from the avatar and from the name in the detail', async () => {
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(row(NAMELESS)?.textContent).toContain('npub1cccc'));
    const avatar = row(NAMELESS)!.parentElement!.querySelector<HTMLButtonElement>('[data-testid="radar-avatar"]')!;
    avatar.click();
    await vi.waitFor(() => expect(invokeNappletIntent).toHaveBeenCalledWith(expect.objectContaining({ payload: { pubkey: NAMELESS } })));

    vi.mocked(invokeNappletIntent).mockClear();
    row(NAMED)!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="radar-open-profile"]')?.textContent).toContain('Ines Okafor'));
    document.querySelector<HTMLButtonElement>('[data-testid="radar-open-profile"]')!.click();
    await vi.waitFor(() => expect(invokeNappletIntent).toHaveBeenCalledWith(expect.objectContaining({ payload: { pubkey: NAMED } })));
    unmount(component);
  });

  it('opens a recent note, and disables Latest Note for someone with none', async () => {
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(row(NAMED)?.textContent).toContain('2m ago'));
    row(NAMED)!.click();
    await vi.waitFor(() => expect(document.querySelector('.activity-item')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.activity-item')!.click();
    await vi.waitFor(() => expect(invokeNappletIntent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ target: { type: 'event', id: NOTE_ID } }),
    })));

    row(NAMELESS)!.click();
    await vi.waitFor(() => {
      const latest = [...document.querySelectorAll<HTMLButtonElement>('.actions button')].find((button) => button.textContent === 'Latest Note');
      expect(latest?.disabled).toBe(true);
    });
    unmount(component);
  });

  it('says when a search matches nobody, clears it, and hides the detail meanwhile', async () => {
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(row(NAMED)).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = 'nothing-matches';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="radar-no-match"]')?.textContent).toContain('nothing-matches'));
    expect(document.querySelector('[data-testid="radar-open-profile"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="radar-no-match"] button')!.click();
    await vi.waitFor(() => expect(row(NAMED)).not.toBeNull());
    unmount(component);
  });
});
