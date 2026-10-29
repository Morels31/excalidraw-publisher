# excalidraw-publisher

Headless publishing pipeline for Obsidian notes and Excalidraw drawings using [Quartz v4](https://quartz.jzhao.xyz/) and Docker.

## Features

- **Excalidraw to SVG**: Converts digital pen drawings (both raw JSON and LZ-String compressed notes) into responsive vector SVGs.
- **Incremental Caching**: Compares file modification times (`mtime`) to skip unchanged notes in milliseconds.
- **Strict File Filtering**: Only publishes `.md`, `.svg`, `.pdf`, and web images (`.png`, `.jpg`, `.webp`), ignoring scratch and office files (`.ods`, `.docx`, `.xopp`).
- **Orphan Pruning**: Deletions and renames in the source vault are automatically mirrored, removing stale files and empty directories.
- **Preserves Wikilinks**: Full support for internal links, backlinks, KaTeX math (`$...$`), and full-text search.

## Usage

1. In `docker-compose.yaml`, set your domain and notes directory mount:
   ```yaml
   environment:
     - BASE_URL=notes.yourdomain.com
   volumes:
     - /path/to/vault/<folder-name>:/vault-input/<folder-name>:ro
   ```

   > **Warning on Wikilinks**: The container destination path must preserve the folder's name relative to your vault root (e.g. `/vault-input/<folder-name>`). For example, if you publish a vault subfolder called `Notes`, mount it as `/vault-input/Notes`. This ensures that Obsidian wikilinks starting with `[[Notes/...]]` resolve correctly without broken links.

2. Build and launch:
   ```bash
   docker compose up -d --build
   ```

3. Open `http://<server-ip>:8080`.

## Architecture

- **`convert.mjs`**: Runs in the background, watches `/vault-input` for changes, renders Excalidraw drawings to SVGs, and syncs allowed files into `./quartz-content`.
- **Quartz**: Compiles and serves the static site on port 8080 with live hot-reloading.
- **`./quartz-content`**: Host directory caching the converted notes, SVGs, and assets.

## Cache Management

To force a full rebuild from scratch:
```bash
rm -rf ./quartz-content && docker compose restart
```
