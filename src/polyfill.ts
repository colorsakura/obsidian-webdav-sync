type ProcessLike = typeof globalThis.process & {
	env?: Record<string, string | undefined>
}

const processLike: ProcessLike = (globalThis.process ?? {
	cwd() {
		return '/'
	},
	env: {},
}) as ProcessLike

if (typeof processLike.cwd !== 'function') {
	processLike.cwd = () => '/'
}

if (!processLike.env || typeof processLike.env !== 'object') {
	processLike.env = {}
}

globalThis.process = processLike

export {}
