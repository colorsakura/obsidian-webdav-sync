import deepStringify from './deep-stringify'

export default function (logs: string | unknown[]): string | undefined {
	if (typeof logs === 'string') {
		return logs
	}
	try {
		return JSON.stringify(logs)
	} catch {
		try {
			return deepStringify(logs)
		} catch {}
	}
}
