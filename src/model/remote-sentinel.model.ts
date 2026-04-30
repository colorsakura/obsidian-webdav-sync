export interface RemoteSentinel {
	/** 顶层 PROPFIND 结果的指纹 */
	fingerprint: string
	/** 指纹生成时间（毫秒时间戳） */
	updatedAt: number
}
