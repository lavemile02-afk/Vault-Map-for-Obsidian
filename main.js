"use strict";
// Vault Map — writes a JSON Lines index of every note in the vault (frontmatter,
// links, embeds, citation links, backlinks, unresolved links) that scripts and
// AI agents can read without scanning the vault themselves.
//
// Everything comes from Obsidian's own metadata cache, so links resolve exactly
// as they do in Obsidian and any valid YAML frontmatter is supported.
// Single file, plain JavaScript, no build step.

const { Plugin, Notice, Modal, PluginSettingTab, Setting, getLinkpath, normalizePath } = require("obsidian");

const SCHEMA_VERSION = 3;

const DEFAULT_SETTINGS = {
  outputPath: "VAULT-MAP.jsonl",
  exclusions: [],
  orphanFolders: [],
  keepBackup: true,
  notifyLevel: "summary", // "silent" | "summary" | "detailed"
  autoOnStartup: false,
  autoOnChange: false,
  autoDelaySeconds: 10,
};

const SCHEMA_DOC = {
  path: "vault-relative path, forward slashes",
  title: "file name without .md — the string wikilinks resolve against",
  folder: "vault-relative parent folder, '' for the vault root",
  frontmatter: "YAML frontmatter as parsed by Obsidian ({} if none)",
  links_out: "targets of this note's links ([[wikilinks]], [markdown](links) and links in properties), anchors and aliases removed, deduplicated: the title of the linked note, the file name for other files, or the raw link text when unresolved",
  embeds_out: "same, for ![[embeds]] (images, PDFs, transcluded notes), kept separate from links_out",
  citations_out: "works this note cites with citation links to a passage ([text](obsidian://cite?note=…&q=…), the format of the Better Citations plugin), deduplicated: the title of the cited note; 'doi:' and the DOI for a work cited by DOI only, or whose note is not found; the raw note text otherwise. Not in links_out",
  line_count: "number of lines in the file, a cheap proxy for its size",
  unresolved_out: "subset of links_out that points to no existing file (broken links)",
  backlinks: "titles of the other notes that link to this note",
};

const NOTE_FIELDS = ["title", "folder", "frontmatter", "links_out", "embeds_out", "citations_out", "line_count", "unresolved_out", "backlinks"];

// ---------- Citation links ----------
// A citation link points to a passage of a work: [text](obsidian://cite?note=…&doi=…&occ=…&qe=…&q=…),
// the format of the Better Citations plugin. Obsidian does not index these
// links (they are URLs), so they are read from the note's text.

const CITE_PREFIX = "obsidian://cite?";
const CITE_PARAMS = ["note", "q", "qe", "occ", "doi"];

function safeDecode(text) {
  try {
    return decodeURIComponent(text.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  } catch (e) {
    return text;
  }
}

// The "note" and "doi" of a citation URL. A value runs to the next known
// parameter, so a quoted passage may itself contain "&" or "=".
function citeTarget(url) {
  const query = url.slice(CITE_PREFIX.length);
  const boundary = new RegExp(`(?:^|&)(${CITE_PARAMS.join("|")})=`, "g");
  const starts = [];
  let m;
  while ((m = boundary.exec(query)) !== null) starts.push({ key: m[1], start: m.index, valueStart: m.index + m[0].length });
  const values = {};
  starts.forEach((st, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start : query.length;
    if (!(st.key in values)) values[st.key] = safeDecode(query.slice(st.valueStart, end)).trim();
  });
  return { note: values.note || "", doi: values.doi || "" };
}

// The citation URLs of a note, outside code (fenced blocks and inline code).
// A destination in angle brackets ends at ">"; otherwise at the first
// unbalanced ")" (a quoted passage may contain spaces and balanced parentheses).
function citationUrls(text) {
  const urls = [];
  let inCode = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) inCode = !inCode;
    if (inCode || !raw.includes(CITE_PREFIX)) continue;
    const line = raw.replace(/`[^`]*`/g, (code) => " ".repeat(code.length));
    let from = 0;
    for (;;) {
      const at = line.indexOf("](", from);
      if (at < 0) break;
      let start = at + 2;
      const angled = line[start] === "<";
      if (angled) start++;
      from = start;
      if (!line.startsWith(CITE_PREFIX, start)) continue;
      let end = start;
      if (angled) {
        end = line.indexOf(">", start);
        if (end < 0) break;
      } else {
        for (let depth = 0; end < line.length; end++) {
          if (line[end] === "(") depth++;
          if (line[end] === ")") { if (depth === 0) break; depth--; }
        }
      }
      urls.push(line.slice(start, end));
      from = end;
    }
  }
  return urls;
}

// Fixed locale so the file order is the same whatever Obsidian's language.
const collator = new Intl.Collator("en");
const byLocale = (a, b) => collator.compare(a, b);

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- Exclusions (gitignore-like patterns) ----------
// - no "/"   → matches a file or folder name anywhere ("drafts", "*.excalidraw.md")
// - with "/" → path from the vault root; a folder excludes its contents ("Templates/", "Daily/**/2023-*")
// - "*" = anything but "/", "**" = anything, "?" = one character, "#" = comment

function globToRegexSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else { out += ".*"; }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

function compileExclusions(patterns) {
  const nameRes = [];
  const pathRes = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    if (p.includes("/")) {
      const body = p.replace(/^\/+|\/+$/g, "");
      if (body) pathRes.push(new RegExp("^" + globToRegexSource(body) + "(?:/.*)?$"));
    } else {
      nameRes.push(new RegExp("^" + globToRegexSource(p) + "$"));
    }
  }
  return (path) =>
    pathRes.some((re) => re.test(path)) ||
    (nameRes.length > 0 && path.split("/").some((part) => nameRes.some((re) => re.test(part))));
}

// ---------- Comparing two versions of the map ----------

function parseMap(text) {
  let meta = null;
  const notes = new Map(); // path -> { obj, line }
  for (const line of (text || "").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj._meta) meta = obj;
    else if (obj.path) notes.set(obj.path, { obj, line });
  }
  return { meta, notes };
}

function diffMaps(oldText, newText) {
  const a = parseMap(oldText);
  const b = parseMap(newText);
  const added = [], removed = [], modified = [], lostAllLinks = [];
  for (const [path, nb] of b.notes) {
    const na = a.notes.get(path);
    if (!na) { added.push(path); continue; }
    if (na.line === nb.line) continue;
    const fields = NOTE_FIELDS.filter((f) => JSON.stringify(na.obj[f]) !== JSON.stringify(nb.obj[f]));
    modified.push({ path, fields });
    if ((na.obj.links_out || []).length > 0 && (nb.obj.links_out || []).length === 0) lostAllLinks.push(path);
  }
  for (const path of a.notes.keys()) if (!b.notes.has(path)) removed.push(path);

  const minus = (x, y) => x.filter((v) => !y.includes(v));
  const keys = (meta, k) => Object.keys((meta && meta[k]) || {});
  const list = (meta, k) => (meta && meta[k]) || [];
  const stable = (meta) => {
    if (!meta) return null;
    const { generated_at, generated_by, ...rest } = meta;
    return JSON.stringify(rest);
  };
  return {
    oldMeta: a.meta,
    newMeta: b.meta,
    added,
    removed,
    modified,
    lostAllLinks,
    newUnresolved: minus(keys(b.meta, "unresolved_links"), keys(a.meta, "unresolved_links")),
    fixedUnresolved: minus(keys(a.meta, "unresolved_links"), keys(b.meta, "unresolved_links")),
    newOrphans: minus(list(b.meta, "orphans"), list(a.meta, "orphans")),
    fixedOrphans: minus(list(a.meta, "orphans"), list(b.meta, "orphans")),
    newDuplicates: minus(keys(b.meta, "duplicate_titles"), keys(a.meta, "duplicate_titles")),
    changed: added.length + removed.length + modified.length > 0 || stable(a.meta) !== stable(b.meta),
  };
}

// ---------- Plugin ----------

module.exports = class VaultMapPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.isExcluded = compileExclusions(this.settings.exclusions);
    this.running = false;
    this.rerun = false;
    this.pending = false;
    this.timer = null;

    this.addRibbonIcon("map", "Regenerate vault map", () => this.regenerate());
    this.addCommand({ id: "regenerate", name: "Regenerate map", callback: () => this.regenerate() });
    this.addCommand({ id: "show-changes", name: "Show changes since the previous map", callback: () => this.showChanges() });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("vault-map-status");
    this.registerDomEvent(this.statusEl, "click", () => this.showChanges());

    this.addSettingTab(new VaultMapSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.refreshStatusBar();
      const { metadataCache, vault } = this.app;
      const onChange = (file, oldPath) => {
        if (!this.settings.autoOnChange) return;
        const paths = [file && file.path, oldPath].filter((p) => p && p.endsWith(".md"));
        if (paths.length && !paths.every((p) => this.isExcluded(p))) this.schedule();
      };
      this.registerEvent(metadataCache.on("changed", (file) => onChange(file)));
      this.registerEvent(vault.on("delete", (file) => onChange(file)));
      this.registerEvent(vault.on("rename", (file, oldPath) => onChange(file, oldPath)));
      // Links are resolved in the background; wait for Obsidian to finish before a pending run.
      this.registerEvent(metadataCache.on("resolved", () => { if (this.pending) this.schedule(); }));
      if (this.settings.autoOnStartup) this.schedule();
    });
  }

  onunload() {
    window.clearTimeout(this.timer);
  }

  async saveSettings() {
    this.isExcluded = compileExclusions(this.settings.exclusions);
    await this.saveData(this.settings);
  }

  outputPath() {
    return normalizePath(this.settings.outputPath || DEFAULT_SETTINGS.outputPath);
  }

  // Debounced automatic run: waits for a quiet period with no further changes.
  schedule() {
    this.pending = true;
    window.clearTimeout(this.timer);
    const delay = Math.max(2, Number(this.settings.autoDelaySeconds) || DEFAULT_SETTINGS.autoDelaySeconds) * 1000;
    this.timer = window.setTimeout(() => this.regenerate({ auto: true }), delay);
  }

  // ---------- Building the map ----------

  async buildMap(onProgress) {
    const { vault, metadataCache } = this.app;
    const outPath = this.outputPath();
    const files = vault.getMarkdownFiles()
      .filter((f) => f.path !== outPath && !this.isExcluded(f.path))
      .sort((a, b) => byLocale(a.path, b.path));

    const notes = [];
    const titles = new Map(); // title -> [paths]
    const incoming = new Map(); // note path -> Set(titles of notes linking to it)
    const unresolvedLinks = new Map(); // link text -> [paths]

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const cache = metadataCache.getFileCache(file) || {};

      const collect = (refs) => {
        const targets = new Set();
        const unresolved = new Set();
        for (const ref of refs || []) {
          const linkpath = getLinkpath(ref.link);
          if (!linkpath) continue; // link to a heading of the same note
          const dest = metadataCache.getFirstLinkpathDest(linkpath, file.path);
          if (!dest) {
            targets.add(linkpath);
            unresolved.add(linkpath);
            continue;
          }
          targets.add(dest.extension === "md" ? dest.basename : dest.name);
          if (dest.extension === "md" && dest.path !== file.path) {
            if (!incoming.has(dest.path)) incoming.set(dest.path, new Set());
            incoming.get(dest.path).add(file.basename);
          }
        }
        return { targets: [...targets], unresolved: [...unresolved] };
      };

      const links = collect([...(cache.links || []), ...(cache.frontmatterLinks || [])]);
      const embeds = collect(cache.embeds);
      for (const t of links.unresolved) {
        if (!unresolvedLinks.has(t)) unresolvedLinks.set(t, []);
        unresolvedLinks.get(t).push(file.path);
      }

      if (!titles.has(file.basename)) titles.set(file.basename, []);
      titles.get(file.basename).push(file.path);

      const text = await vault.cachedRead(file);
      const citations = new Set();
      for (const url of citationUrls(text)) {
        const { note, doi } = citeTarget(url);
        const dest = note ? metadataCache.getFirstLinkpathDest(getLinkpath(note), file.path) : null;
        if (dest && dest.extension === "md") citations.add(dest.basename);
        else if (doi) citations.add(`doi:${doi.toLowerCase()}`);
        else if (note) citations.add(note);
      }
      notes.push({
        path: file.path,
        title: file.basename,
        folder: file.parent && file.parent.path !== "/" ? file.parent.path : "",
        frontmatter: cache.frontmatter ? JSON.parse(JSON.stringify(cache.frontmatter)) : {},
        links_out: links.targets,
        embeds_out: embeds.targets,
        citations_out: [...citations],
        line_count: text.split("\n").length,
        unresolved_out: links.unresolved,
      });
      if (onProgress && (i % 50 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
    }

    for (const n of notes) n.backlinks = [...(incoming.get(n.path) || [])].sort(byLocale);

    const duplicateTitles = {};
    for (const [title, paths] of titles) if (paths.length > 1) duplicateTitles[title] = paths;

    const orphanFolders = this.settings.orphanFolders.map((f) => normalizePath(f)).filter((f) => f && f !== "/");
    const inScope = (path) => orphanFolders.length === 0 || orphanFolders.some((f) => path.startsWith(f + "/"));
    const orphans = notes.filter((n) => n.backlinks.length === 0 && inScope(n.path)).map((n) => n.path);

    const meta = {
      _meta: true,
      schema_version: SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      generated_by: `vault-map ${this.manifest.version}`,
      total_notes: notes.length,
      schema_doc: SCHEMA_DOC,
      unresolved_links: Object.fromEntries([...unresolvedLinks.entries()].sort((a, b) => byLocale(a[0], b[0]))),
      duplicate_titles: duplicateTitles,
      orphans,
      orphan_folders: orphanFolders,
    };

    const lines = [JSON.stringify(meta), ...notes.map((n) => JSON.stringify(n))];
    return { text: lines.join("\n") + "\n", meta };
  }

  // ---------- Generation ----------

  async regenerate({ auto = false } = {}) {
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    this.pending = false;
    window.clearTimeout(this.timer);

    let progressNotice = null;
    let progress = "";
    const slow = window.setTimeout(() => { progressNotice = new Notice(`Vault map: building… ${progress}`, 0); }, 1000);

    try {
      const adapter = this.app.vault.adapter;
      const outPath = this.outputPath();
      const { text, meta } = await this.buildMap((done, total) => {
        progress = `${done}/${total}`;
        if (progressNotice) progressNotice.setMessage(`Vault map: building… ${progress}`);
      });

      const previous = (await adapter.exists(outPath)) ? await adapter.read(outPath) : null;
      const diff = diffMaps(previous || "", text);

      const folder = outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : "";
      if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
      // The previous version is saved before being replaced, so a failed write never loses it.
      if (this.settings.keepBackup && previous !== null && diff.changed) await adapter.write(outPath + ".bak", previous);
      await adapter.write(outPath, text);

      this.notify({ meta, diff, firstRun: previous === null }, auto);
    } catch (e) {
      console.error("Vault map", e);
      new Notice(`Vault map: generation failed.\n${e.message}`, 10000);
    } finally {
      window.clearTimeout(slow);
      if (progressNotice) progressNotice.hide();
      this.running = false;
      this.refreshStatusBar();
    }
    if (this.rerun) {
      this.rerun = false;
      this.regenerate({ auto: true });
    }
  }

  notify({ meta, diff, firstRun }, auto) {
    const warnings = [];
    if (!firstRun) {
      if (diff.lostAllLinks.length) warnings.push(`⚠ Lost all its links: ${diff.lostAllLinks.join(", ")}`);
      if (diff.newDuplicates.length) warnings.push(`⚠ New duplicate title: ${diff.newDuplicates.join(", ")}`);
    }
    let level = this.settings.notifyLevel;
    if (auto && level === "summary") level = "silent"; // automatic runs stay quiet…
    if (level === "silent" && warnings.length) level = "summary"; // …unless something looks wrong
    if (level === "silent") return;

    const out = [`Vault map: ${plural(meta.total_notes, "note")}.`];
    if (firstRun) out.push("Map created.");
    else if (!diff.changed) out.push("No changes since the previous map.");
    else out.push(`${diff.added.length} added, ${diff.removed.length} removed, ${diff.modified.length} modified.`);
    const dups = Object.keys(meta.duplicate_titles).length;
    out.push([
      plural(meta.orphans.length, "orphan"),
      plural(Object.keys(meta.unresolved_links).length, "unresolved link"),
      dups ? plural(dups, "duplicate title") : "",
    ].filter(Boolean).join(" · "));
    out.push(...warnings);
    if (!firstRun && diff.newOrphans.length) out.push(`${plural(diff.newOrphans.length, "new orphan")}`);
    if (!firstRun && diff.newUnresolved.length) out.push(`${plural(diff.newUnresolved.length, "new unresolved link")}`);

    if (level === "detailed" && !firstRun) {
      const MAX = 15;
      const show = (label, items) => {
        if (!items.length) return;
        out.push(`${label}:`);
        for (const item of items.slice(0, MAX)) out.push(`  • ${item}`);
        if (items.length > MAX) out.push(`  … and ${items.length - MAX} more`);
      };
      show("Added", diff.added);
      show("Removed", diff.removed);
      show("Modified", diff.modified.map((m) => `${m.path} (${m.fields.join(", ")})`));
    }
    new Notice(out.join("\n"), level === "detailed" ? 15000 : 6000);
  }

  // ---------- Status bar ----------

  async refreshStatusBar() {
    let meta = null;
    try {
      const text = await this.app.vault.adapter.read(this.outputPath());
      meta = JSON.parse(text.slice(0, text.indexOf("\n")));
    } catch { /* no map yet */ }

    if (!meta || !meta._meta) {
      this.statusEl.setText("Vault map: —");
      this.statusEl.setAttr("aria-label", "No map generated yet");
      return;
    }
    const d = new Date(meta.generated_at);
    const when = d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { day: "numeric", month: "short" });
    this.statusEl.setText(`Vault map: ${meta.total_notes} notes · ${when}`);
    this.statusEl.setAttr("aria-label", `Generated ${d.toLocaleString()}. Click to see what changed.`);
  }

  // ---------- Changes view ----------

  async showChanges() {
    const adapter = this.app.vault.adapter;
    const read = async (p) => ((await adapter.exists(p)) ? adapter.read(p) : null);
    const current = await read(this.outputPath());
    const previous = await read(this.outputPath() + ".bak");
    new ChangesModal(this.app, current, previous).open();
  }
};

class ChangesModal extends Modal {
  constructor(app, current, previous) {
    super(app);
    this.current = current;
    this.previous = previous;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("vault-map-changes");
    this.titleEl.setText("Vault map changes");

    if (!this.current) { contentEl.createEl("p", { text: "No map has been generated yet." }); return; }
    if (!this.previous) { contentEl.createEl("p", { text: "No previous version (.bak) to compare with." }); return; }

    const d = diffMaps(this.previous, this.current);
    const when = (meta) => (meta ? new Date(meta.generated_at).toLocaleString() : "?");
    contentEl.createEl("p", { cls: "vault-map-period", text: `${when(d.oldMeta)} → ${when(d.newMeta)}` });

    let any = false;
    const section = (title, items, render) => {
      if (!items.length) return;
      any = true;
      contentEl.createEl("h4", { text: `${title} (${items.length})` });
      const ul = contentEl.createEl("ul");
      for (const item of items) render(ul.createEl("li"), item);
    };
    const noteLink = (li, path, suffix) => {
      const a = li.createEl("a", { text: path, href: "#" });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.close();
        this.app.workspace.openLinkText(path, "", false);
      });
      if (suffix) li.appendText(" " + suffix);
    };
    const plain = (li, text) => li.setText(text);

    section("⚠ Notes that lost all their links", d.lostAllLinks, (li, p) => noteLink(li, p));
    section("⚠ New duplicate titles", d.newDuplicates, plain);
    section("Added notes", d.added, (li, p) => noteLink(li, p));
    section("Removed notes", d.removed, plain);
    section("Modified notes", d.modified, (li, m) => noteLink(li, m.path, `— ${m.fields.join(", ")}`));
    section("New orphans", d.newOrphans, (li, p) => noteLink(li, p));
    section("No longer orphans", d.fixedOrphans, (li, p) => noteLink(li, p));
    section("New unresolved links", d.newUnresolved, plain);
    section("Fixed unresolved links", d.fixedUnresolved, plain);

    if (!any) contentEl.createEl("p", { text: "The two versions are identical." });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class VaultMapSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl, plugin } = this;
    const s = plugin.settings;
    const save = async () => { await plugin.saveSettings(); };
    const lines = (v) => v.split("\n").map((l) => l.trim()).filter(Boolean);
    containerEl.empty();

    new Setting(containerEl)
      .setName("Regenerate now")
      .setDesc("Rebuild the map with the current settings.")
      .addButton((b) => b.setButtonText("Regenerate").setCta().onClick(() => plugin.regenerate()));

    new Setting(containerEl).setName("Output").setHeading();

    new Setting(containerEl)
      .setName("Output file")
      .setDesc("Path from the vault root. Hidden folders (starting with a dot) are allowed.")
      .addText((t) => t
        .setPlaceholder(DEFAULT_SETTINGS.outputPath)
        .setValue(s.outputPath)
        .onChange(async (v) => { s.outputPath = v.trim() || DEFAULT_SETTINGS.outputPath; await save(); plugin.refreshStatusBar(); }));

    new Setting(containerEl)
      .setName("Keep the previous version")
      .setDesc("Save the old map as a .bak file when it changes. Needed to show changes.")
      .addToggle((t) => t.setValue(s.keepBackup).onChange(async (v) => { s.keepBackup = v; await save(); }));

    new Setting(containerEl).setName("Content").setHeading();

    const exclusions = new Setting(containerEl)
      .setName("Excluded files and folders")
      .addTextArea((t) => {
        t.setValue(s.exclusions.join("\n")).onChange(async (v) => { s.exclusions = lines(v); await save(); });
        t.inputEl.rows = 6;
        t.inputEl.addClass("vault-map-textarea");
      });
    exclusions.descEl.appendText("One pattern per line.");
    const ul = exclusions.descEl.createEl("ul");
    ul.createEl("li", { text: "Without \"/\": any file or folder with that name, anywhere (drafts, *.excalidraw.md)." });
    ul.createEl("li", { text: "With \"/\": a path from the vault root (Templates/, Daily/**/2023-*)." });
    ul.createEl("li", { text: "* matches anything except \"/\", ** matches anything, ? matches one character, # starts a comment." });

    new Setting(containerEl)
      .setName("Folders checked for orphans")
      .setDesc("Notes with no incoming links are listed as orphans only if they are in one of these folders (subfolders included). One folder per line; leave empty to check the whole vault.")
      .addTextArea((t) => {
        t.setValue(s.orphanFolders.join("\n")).onChange(async (v) => { s.orphanFolders = lines(v); await save(); });
        t.inputEl.rows = 3;
        t.inputEl.addClass("vault-map-textarea");
      });

    new Setting(containerEl).setName("Notifications").setHeading();

    new Setting(containerEl)
      .setName("Detail level")
      .setDesc("With \"Summary\", automatic runs stay silent unless something looks wrong (a note lost all its links, a new duplicate title).")
      .addDropdown((d) => d
        .addOption("silent", "Silent")
        .addOption("summary", "Summary")
        .addOption("detailed", "Detailed")
        .setValue(s.notifyLevel)
        .onChange(async (v) => { s.notifyLevel = v; await save(); }));

    new Setting(containerEl).setName("Automatic regeneration").setHeading();

    new Setting(containerEl)
      .setName("When the vault opens")
      .addToggle((t) => t.setValue(s.autoOnStartup).onChange(async (v) => { s.autoOnStartup = v; await save(); }));

    new Setting(containerEl)
      .setName("After changes")
      .setDesc("Regenerate when a note is created, edited, renamed or deleted, once no further change happens for the delay below.")
      .addToggle((t) => t.setValue(s.autoOnChange).onChange(async (v) => { s.autoOnChange = v; await save(); }));

    new Setting(containerEl)
      .setName("Delay (seconds)")
      .addSlider((sl) => sl
        .setLimits(2, 120, 1)
        .setValue(s.autoDelaySeconds)
        .setDynamicTooltip()
        .onChange(async (v) => { s.autoDelaySeconds = v; await save(); }));
  }
}
