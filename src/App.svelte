<script lang="ts">
  import { onMount } from 'svelte';
  import { inc as ipc } from '@napplet/sdk';
  import { NOTE_VIEWER_OPEN_TOPIC, createNoteViewerOpenPayload, pubkeyColorStyle } from '@hyprgate/utils';
  import {
    createRadarStore,
    latestActivity,
    relationshipCounts,
    selectedPerson,
    visiblePeople,
    type RadarPerson,
    type RadarState,
  } from './lib/people-radar-store';

  let state = $state<RadarState>({ people: [], selectedPubkey: null, query: '', loading: true, error: null });
  const store = createRadarStore(() => {
    state = { ...store.state };
  });
  const people = $derived(visiblePeople(state));
  const selected = $derived(selectedPerson(state));
  const counts = $derived(relationshipCounts(state.people));

  onMount(() => {
    store.load();
    return () => store.destroy();
  });

  function selectPerson(person: RadarPerson): void {
    store.select(person.pubkey);
  }

  function setQuery(value: string): void {
    store.setQuery(value);
  }

  function openProfile(person: RadarPerson): void {
    ipc.emit('profile:open', [], JSON.stringify({ pubkey: person.pubkey }));
  }

  function openLatestNote(person: RadarPerson): void {
    const latest = latestActivity(person);
    if (!latest) return;
    const payload = createNoteViewerOpenPayload({
      target: { type: 'event', id: latest.noteId },
      source: { napplet: 'people-radar' },
      behavior: { focus: true, newWindow: true },
    });
    if (payload) ipc.emit(NOTE_VIEWER_OPEN_TOPIC, [], JSON.stringify(payload));
  }
</script>

<main class="radar-shell">
  <header class="toolbar">
    <input aria-label="Search people" placeholder="search..." value={state.query} oninput={(event) => setQuery(event.currentTarget.value)} />
  </header>

  <section class="stats" aria-label="Relationship counts">
    <span>following {counts.following}</span>
    <span>pinned {counts.pinned}</span>
    <span>lists {counts.list}</span>
    <span>muted {counts.muted}</span>
  </section>

  <section class="content">
    <section class="people" aria-label="People">
      {#each people as person}
        <button type="button" class="person" class:selected={selected?.pubkey === person.pubkey} onclick={() => selectPerson(person)}>
          <span class="name" style={pubkeyColorStyle(person.pubkey)}>{person.name}</span>
          <span class="handle" style={pubkeyColorStyle(person.pubkey)}>{person.handle}</span>
          <span class="meta">{person.relationship} / {person.recent.length} recent</span>
        </button>
      {/each}
      {#if state.loading}
        <p class="empty">Loading people...</p>
      {:else if state.error}
        <p class="empty">{state.error}</p>
      {:else if people.length === 0}
        <p class="empty">No people found from identity or follows.</p>
      {/if}
    </section>

    <aside class="detail">
      {#if selected}
        <p class="eyebrow">{selected.relationship} / {selected.list}</p>
        <h2 style={pubkeyColorStyle(selected.pubkey)}>{selected.name}</h2>
        <p style={pubkeyColorStyle(selected.pubkey)}>{selected.handle}</p>
        <code style={pubkeyColorStyle(selected.pubkey)}>{selected.pubkey}</code>
        <div class="relay">{selected.relayHint}</div>
        <div class="actions">
          <button type="button" onclick={() => openProfile(selected)}>Profile</button>
          <button type="button" onclick={() => openLatestNote(selected)}>Latest Note</button>
        </div>
        <div class="activity">
          {#each selected.recent as item}
            <article>
              <span>{item.label}</span>
              <strong>{item.summary}</strong>
            </article>
          {/each}
        </div>
      {/if}
    </aside>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--hg-bg, #070707);
    color: var(--hg-text, #f3f1e8);
    font-family: var(--hg-font-body, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  }

  .radar-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .toolbar, .stats {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 12px;
    background: var(--hg-surface, #101010);
    border-bottom: 1px solid var(--hg-border, #303030);
  }

  .stats {
    justify-content: flex-start;
    flex-wrap: wrap;
    padding-block: 8px;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 12px;
  }

  .toolbar input {
    flex: 1;
  }

  h2, p {
    margin: 0;
    letter-spacing: 0;
  }

  h2 {
    font-size: 18px;
  }

  .eyebrow {
    color: var(--hg-accent, #9ee493);
    font-size: 11px;
    text-transform: uppercase;
  }

  input, button {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: var(--hg-surface, #111);
    color: var(--hg-text, #f3f1e8);
    font: inherit;
    padding: 8px 10px;
  }

  button {
    cursor: pointer;
  }

  button:hover, button.selected, input:focus {
    border-color: var(--hg-accent, #9ee493);
    outline: none;
  }

  .content {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 0.8fr);
  }

  .people {
    overflow: auto;
    padding: 12px;
  }

  .person {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(130px, 0.5fr) minmax(0, 1fr) 120px;
    gap: 10px;
    text-align: left;
    margin-bottom: 8px;
  }

  .handle, .meta {
    color: var(--hg-text-muted, #b8b1a4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    border-left: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  code, .relay {
    color: var(--hg-accent-cyan, #82d8f7);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .activity {
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: auto;
  }

  .empty {
    color: var(--hg-text-muted, #b8b1a4);
    padding: 10px;
  }

  article {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    padding: 10px;
  }

  article span {
    color: var(--hg-accent, #9ee493);
    display: block;
    font-size: 11px;
    text-transform: uppercase;
  }

  @media (max-width: 760px) {
    .toolbar, .content {
      display: flex;
      flex-direction: column;
    }

    .detail {
      border-left: 0;
      border-top: 1px solid var(--hg-border, #303030);
    }

    .person {
      grid-template-columns: 1fr;
    }
  }
</style>
