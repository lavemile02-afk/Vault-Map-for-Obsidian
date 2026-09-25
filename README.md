# Vault Map

Vault Map writes a single [JSON Lines](https://jsonlines.org/) file that indexes every note in your vault: its frontmatter, outgoing links, embeds, backlinks and broken links, plus vault-wide lists of unresolved links, duplicate titles and orphan notes.

It is meant for tools that work on your vault from the outside, such as scripts or AI coding agents (Claude Code, Codex, Cursor…). Instead of opening hundreds of notes to find out what links to what, they read one small file. Everything comes from Obsidian's own metadata cache, so links are resolved exactly as Obsidian resolves them.

## Features

- **One click:** a ribbon icon and a command (*Vault Map: Regenerate map*) rebuild the file.
- **Automatic updates (optional):** regenerate when the vault opens and/or a few seconds after notes change, including changes made by other programs while Obsidian is open.
- **Change summary:** after each run, a notification tells you how many notes were added, removed or modified, and warns you when a note suddenly loses all its links or when a new duplicate title appears.
- **Previous version kept:** the old file is saved as `.bak` before being replaced. The command *Vault Map: Show changes since the previous map* lists what changed between the two.
- **Status bar:** shows how many notes are mapped and when the map was last generated.
- **Exclusions:** leave out files and folders with gitignore-like patterns.

## Output format

The first line is a metadata object, followed by one line per note, sorted by path.

```jsonl
{"_meta":true,"schema_version":2,"generated_at":"2026-09-25T17:49:33.000Z","generated_by":"vault-map 1.0.0","total_notes":557,"schema_doc":{…},"unresolved_links":{"Missing note":["Folder/Note.md"]},"duplicate_titles":{},"orphans":["Concepts/Leaf.md"],"orphan_folders":["Concepts"]}
{"path":"Concepts/Peat.md","title":"Peat","folder":"Concepts","frontmatter":{"tags":["soil"],"type":"Concept"},"links_out":["Peatland","Missing note"],"embeds_out":["peat-core.jpeg"],"line_count":42,"unresolved_out":["Missing note"],"backlinks":["Peatland","Sphagnum"]}
```

### Metadata line

| Field | Content |
|---|---|
| `_meta` | Always `true`, to tell this line apart from note lines |
| `schema_version` | Version of this format |
| `generated_at` | Date and time of generation (ISO 8601, UTC) |
| `generated_by` | Plugin name and version |
| `total_notes` | Number of notes in the file |
| `schema_doc` | A short description of every note field, so that a reader needs no other documentation |
| `unresolved_links` | Each broken link target, with the notes that contain it |
| `duplicate_titles` | Titles shared by several notes (which makes wikilinks ambiguous), with their paths |
| `orphans` | Notes that no other note links to, limited to the folders chosen in the settings |
| `orphan_folders` | The folders checked for orphans (empty = the whole vault) |

### Note lines

| Field | Content |
|---|---|
| `path` | Path from the vault root |
| `title` | File name without `.md` |
| `folder` | Parent folder, `""` for the vault root |
| `frontmatter` | Properties as parsed by Obsidian (`{}` if none) |
| `links_out` | Targets of the note's links (wikilinks, Markdown links and links in properties): the linked note's title, the file name for attachments, or the raw link text when the link is broken |
| `embeds_out` | Same, for embeds (`![[…]]` and `![](…)`) |
| `line_count` | Number of lines, a cheap indication of the note's size |
| `unresolved_out` | The broken links among `links_out` |
| `backlinks` | Titles of the other notes that link to this one |

Links inside code blocks are ignored, as in Obsidian.

## Settings

| Setting | Default | Description |
|---|---|---|
| Output file | `VAULT-MAP.jsonl` | Path from the vault root. Hidden folders such as `.claude/` are allowed, which keeps the file out of your file explorer. |
| Keep the previous version | On | Saves the old file as `.bak` when it changes. |
| Excluded files and folders | none | One pattern per line. Without `/`, a pattern matches a file or folder name anywhere (`drafts`, `*.excalidraw.md`). With `/`, it is a path from the vault root (`Templates/`, `Daily/**/2023-*`). `*` matches anything except `/`, `**` matches anything, `?` matches one character, and `#` starts a comment. |
| Folders checked for orphans | none (whole vault) | Only notes in these folders (subfolders included) are reported as orphans. |
| Detail level | Summary | *Silent*, *Summary* or *Detailed* notifications. With *Summary*, automatic runs stay silent unless something looks wrong. |
| When the vault opens | Off | Regenerate the map at startup. |
| After changes | Off | Regenerate after notes are created, edited, renamed or deleted. |
| Delay | 10 s | How long to wait after the last change before regenerating. |

## Privacy

Vault Map works entirely offline. It reads your notes through Obsidian and writes one file (plus its `.bak` copy) at the path you choose inside your vault. It makes no network requests and collects no data.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for *Vault Map*, then install and enable it.

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/lavemile02-afk/Vault-Map-for-Obsidian/releases/latest) into `<your vault>/.obsidian/plugins/vault-map/`, then enable *Vault Map* under **Settings → Community plugins**.

Vault Map currently works on desktop only.

## License

[MIT](LICENSE)
