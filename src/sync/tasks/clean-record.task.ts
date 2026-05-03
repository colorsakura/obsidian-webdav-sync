import { BaseTask } from './task.interface'

/**
 * CleanRecordTask — 清理已删除文件的同步记录。
 * 在新的 DB 架构中，DB 每次同步重建，无需显式清理旧记录。
 * 此任务仅返回成功，不执行任何操作。
 */
export default class CleanRecordTask extends BaseTask {
	exec() {
		return { success: true, skipRecord: true } as const
	}
}
