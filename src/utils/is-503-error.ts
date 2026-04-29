export function is503Error(err: Error | string) {
	const msg = err instanceof Error ? err.message : err
	return (
		msg.includes('503') &&
		(msg.includes('Service Unavailable') ||
			msg.includes('BlockedTemporarily') ||
			msg.includes('Too many requests'))
	)
}
