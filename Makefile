dev: build
	cp main.js ~/Projects/Obsidian/.obsidian/plugins/obsidian-webdav-sync/main.js
	cp styles.css ~/Projects/Obsidian/.obsidian/plugins/obsidian-webdav-sync/styles.css
	cp manifest.json ~/Projects/Obsidian/.obsidian/plugins/obsidian-webdav-sync/manifest.json

test: build
	cp main.js ~/tmp/Test/.obsidian/plugins/obsidian-webdav-sync/main.js
	cp styles.css ~/tmp/Test/.obsidian/plugins/obsidian-webdav-sync/styles.css
	cp manifest.json ~/tmp/Test/.obsidian/plugins/obsidian-webdav-sync/manifest.json

build:
	bun run build

format:
	bun run format