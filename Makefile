dev: build
	cp main.js ~/Projects/Obsidian/.obsidian/plugins/obsidian-webdav-sync/main.js
	cp styles.css ~/Projects/Obsidian/.obsidian/plugins/obsidian-webdav-sync/styles.css
	cp manifest.json ~/Projects/Obsidian/.obsidian/plugins/obsidian-webdav-sync/manifest.json

build:
	bun run build