dev: build
	cp main.js ./Test/.obsidian/plugins/obsidian-webdav-sync/main.js
	cp styles.css ./Test/.obsidian/plugins/obsidian-webdav-sync/styles.css
	cp manifest.json ./Test/.obsidian/plugins/obsidian-webdav-sync/manifest.json

build:
	bun run build