# User guide

**English** · [简体中文](guide.zh-CN.md)

[Project home](../README.md) · [Deployment and maintenance](deployment.md) · [API and authentication](api.md)

RawMark is a single-user workspace with notes stored on your server. Multiple browsers can access the same instance, but it is not a collaboration system and currently has no public sharing feature.

## Start writing

Set a password on first use. A new, empty instance includes seven English example notes that you can edit or delete; they do not return after deletion or restart. Existing vaults are not populated with examples. Subsequent sign-ins require your password and an image captcha. Right-click the **Files** heading or empty space in the sidebar to search, create notes or folders, import documents, open the tag index, or manage images. You can also click the heading to open the menu on a touchscreen.

The editor opens in live preview mode. Use the icons at the top right to switch to source mode, open the outline, or enter focus mode. Supported syntax includes standard Markdown, tables, task lists, code blocks, math, Mermaid, footnotes, and YAML metadata.

Changes save automatically. Save failures and version conflicts are reported explicitly. Changes made by external programs sync to the page; if a conflict occurs, compare the contents before overwriting a version you still need.

Select text to apply appearance styles, bold, italic, underline, strikethrough, highlight, or links. Local appearance styles and underlines are stored as restricted standard HTML tags in Markdown and preserved in source mode and exports. Rendering in other readers depends on their HTML support.

## Organize notes

- **Files and folders:** right-click to rename, move, delete, or export. Dropping onto a folder row moves the item into that folder; dropping onto a note row moves it into that note's parent folder.
- **Multiple selection:** Ctrl/Cmd-click toggles selection; Shift-click selects a visible range. Use the context menu for bulk actions. Partial failures are reported individually.
- **Tabs:** pin notes or close other tabs. Pinned tabs survive “Close other tabs.” Open tabs and their pinned state are stored in the current browser and restored after refreshes and restarts.
- **Icons:** folders default to 📂 and files to 📄. Click an icon or choose the change-icon context action to select an emoji or a built-in icon.
- **Tags and search:** use inline `#tags` or YAML `tags` to categorize notes, and full-text search to find them. Headings populate the document outline on the right.

Renaming and moving items within RawMark updates local links and image references. Direct filesystem operations do not guarantee that links, icons, or other metadata follow; prefer performing these operations in RawMark.

## Import and export

Choose the import action from the directory or folder menu. Import supports multiple UTF-8 `.md` files or one ZIP archive, with a total upload limit of 100 MiB.

A ZIP imports into a new folder named after the archive, preserving the note hierarchy. Local images move into an `assets/` folder alongside each note, and references are rewritten. Files with the same name but different contents are not overwritten. Missing local links are reported; remote images are not downloaded automatically. Markdown ZIP exports from tools such as SiYuan can be imported, with formatting determined by their Markdown contents.

Exporting a single note without attachments downloads an `.md` file. Other selections download a ZIP preserving the hierarchy, original text, and local attachments; remote resources are not downloaded. Missing attachments in a selection cause an error so you can repair them before exporting.

A plain Markdown export of the entire vault is available under **Settings → Storage**. Missing attachments are recorded in `.rawmark-export/missing-assets.json` inside the archive. This report does not become a note when reimported.

## Manage images

Pasted, uploaded, and imported images default to the note's sibling `assets/` folder. Identical contents in the same folder are deduplicated, and notes use relative paths. Attachment folders are hidden from the sidebar. Right-click a folder to open its image manager; you can also switch to the entire vault.

The image manager provides search, sorting, grid/list views, bulk uploads, previews, reference lookup, renaming, moving, and replacement. Renaming or moving an image updates note references. Replacement keeps the path, requires the same extension, and has a 50 MiB limit; the old image is not sent to the recycle bin.

Images follow notes moved between folders. Originals still referenced by other notes are retained. **Deleting a single note does not also delete shared images.** Unreferenced-image cleanup shows candidates first, rechecks references across the vault, then sends eligible images to the recycle bin. Legacy `note-name.assets/` folders can still be read, moved, and restored.

## Appearance, fonts, and shortcuts

Use **Settings → Appearance** to change light/dark mode, themes, interface font and size, glass opacity, or CSS snippets. Text and code fonts, text width, and line height are in the editor settings. Settings are stored on the server and shared across devices; local state such as tabs is stored separately.

The default font is Maple Mono Normal NL NF CN v7.9 and cannot be deleted. Interface, text, and code fonts can be selected independently. Each font selector supports importing TTF, OTF, WOFF, and WOFF2 files (up to 30 MiB each) and deleting imported fonts. The page waits for required fonts to load before appearing and offers a refresh action if loading fails. Code blocks always use highlight.js with Atom One Dark, independently of the page's light/dark mode.

Default shortcuts follow Typora's Windows/Linux or macOS bindings. Actions without a corresponding binding and plugin commands default to unassigned. Search, add, remove individual bindings, or reset one action or all shortcuts; conflicting bindings are rejected. Ctrl/Cmd+1–6 sets the corresponding heading level; repeating the same level returns to body text. Browser-reserved shortcuts can be rebound.

On phones, settings use separate category and content views. App installation is available under **Settings → About**. The PWA caches the static shell; **this does not provide offline editing or offline synchronization**.

## Recycle bin and storage

Deleted content goes to the recycle bin, which supports restoring items and emptying all contents. Retention defaults to 30 days; set it to 0 to disable automatic deletion. Changing the retention period also affects existing entries. Cleanup runs at startup and hourly.

**Storage** automatically displays usage for the data directory, external vault, and optional fonts. Font totals exclude the default Maple font; attachments and the recycle bin count toward the vault. You can also export/import the full instance, notes, and settings; optimize/rebuild the index; clean temporary files; reset settings; and export logs.

A full-instance restore replaces current application data and requires signing in again. Back up first. See [Deployment and maintenance](deployment.md#backup-and-restore) for scope, limits, and restore precautions.

## Plugins and interface recovery

Plugins are installed by the instance owner and have full frontend privileges. Only install trusted code; there is no sandbox isolation guarantee. See the [development guide](development.md#themes-fonts-and-plugins) for development details.

If a plugin breaks the interface, append `?disable-plugins` to the URL to pause plugins and access management. If a theme or CSS snippet makes the interface unusable, append `?reset-appearance` to temporarily disable custom appearance, then restore defaults in settings. These entry points do not automatically delete notes or discard edited content.

## Interface language

English is the default. Choose **简体中文** under **Settings → Appearance → Language**; in Chinese, the path is **设置 → 外观 → 语言**. Changes take effect immediately and are saved in account settings across devices without rewriting notes or existing filenames. The sign-in page also offers a temporary language choice; account preferences take precedence after sign-in.
