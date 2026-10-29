# excalidraw-publisher

Headless publishing pipeline for Obsidian notes and Excalidraw drawings using [Quartz](https://quartz.jzhao.xyz/) and Docker.

It automatically renders Excalidraw drawings into vector SVGs, syncs markdown notes, and serves a live static website.

## Setup

1. **Configure `docker-compose.yaml`**:
   - Set your domain in `BASE_URL` (e.g. `notes.example.com`).
   - Set your vault path under `volumes`:
     ```yaml
     volumes:
       - /path/to/vault/<folder-name>:/vault-input/<folder-name>:ro
       - ./quartz-content:/usr/src/app/content
     ```

   > [!IMPORTANT]
   > Keep the destination path relative to your vault root (e.g. `/vault-input/<folder-name>`). For example, if you publish a subfolder called `Notes`, mount it as `/vault-input/Notes` so wikilinks like `[[Notes/...]]` resolve correctly without broken links.

2. **Create the content directory**:
   ```bash
   mkdir -p quartz-content
   sudo chown -R 10001:10001 quartz-content
   ```

3. **Start the service**:
   ```bash
   docker compose up -d --build
   ```

The site is served at `http://<server-ip>:8080`, ready to be placed behind HAProxy or your reverse proxy.

## How it works

- **Excalidraw to SVG**: Detects drawings (both raw and compressed JSON) and renders them into responsive, self-contained SVGs with embedded fonts.
- **Real-time watcher & cache**: Detects additions, changes, and deletions instantly, caching unchanged notes via SHA-256 hashes.
- **Clean publishing**: Only syncs notes and web assets (`.md`, `.svg`, `.pdf`, `.png`, `.jpg`, `.webp`), automatically ignoring dotfiles, `.obsidian/`, and private directories (`private/`, `templates/`).
- **Hardened container**: Runs under an unprivileged user (`10001:10001`) with dropped capabilities, resource limits, and healthcheck.

## Reset cache

To force a full rebuild from scratch:

```bash
docker compose down
rm -rf ./quartz-content
mkdir -p quartz-content
sudo chown -R 10001:10001 quartz-content
docker compose up -d
```
