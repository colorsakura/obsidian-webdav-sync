async function sha256(data: ArrayBuffer) {
	return crypto.subtle.digest('SHA-256', data)
}

export async function sha256Hex(data: ArrayBuffer) {
	const hashBuffer = await sha256(data)
	const hashArray = Array.from(new Uint8Array(hashBuffer))

	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
