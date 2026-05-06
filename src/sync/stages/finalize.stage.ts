import FailedTasksModal, { FailedTaskInfo } from '~/components/FailedTasksModal'
import { emitEndSync } from '~/events'
import getTaskName from '~/utils/get-task-name'
import logger from '~/utils/logger'
import { saveLastSyncDB } from '../utils/sync-db-persistence'
import { buildNewDB } from '../utils/build-new-db'
import { SyncStartMode } from '../index'
import type { SyncContext, PrepareOutput } from './prepare.stage'
import type { ConfirmOutput } from './confirm.stage'
import type { ExecuteOutput } from './execute.stage'

export interface FinalizeInput {
	mode: SyncStartMode
	showNotice: boolean
}

export async function finalize(
	ctx: SyncContext,
	prep: PrepareOutput,
	conf: ConfirmOutput,
	exec: ExecuteOutput,
	opts: FinalizeInput,
): Promise<void> {
	const { mode, showNotice } = opts
	const { confirmedTasks } = conf
	const { allTasksResult } = exec

	// --- Build new DB ---
	const newDB = await buildNewDB(
		prep.localDB,
		prep.remoteDB,
		confirmedTasks,
		allTasksResult,
	)

	// --- Record sync session ---
	let pushCount = 0,
		pullCount = 0,
		removeCount = 0,
		conflictCount = 0
	for (const task of confirmedTasks) {
		const name = task.constructor.name
		if (name.includes('Push')) pushCount++
		else if (name.includes('Pull')) pullCount++
		else if (name.includes('Remove')) removeCount++
		else if (name.includes('Conflict')) conflictCount++
	}

	newDB.insertSyncSession({
		sessionId: prep.sessionId,
		deviceId: prep.deviceId,
		startedAt: prep.startedAt,
		endedAt: Date.now(),
		totalTasks: confirmedTasks.length,
		successCount: allTasksResult.filter((r) => r.success).length,
		failCount: allTasksResult.filter((r) => !r.success).length,
		pushCount,
		pullCount,
		removeCount,
		conflictCount,
		durationMs: Date.now() - prep.startedAt,
		status: allTasksResult.some((r) => !r.success)
			? 'completed_with_errors'
			: 'completed',
		errorMessage: '',
	})

	// --- Upload DB ---
	try {
		await ctx.webdav.createDirectory(
			`${ctx.remoteBaseDir.replace(/\/$/, '')}/_sync`,
			{ recursive: true },
		)
	} catch {
		// _sync 目录可能已存在
	}
	await prep.dbStorage.upload(newDB)

	// --- Save lastSyncDB ---
	await saveLastSyncDB(ctx.vault.getName(), ctx.remoteBaseDir, newDB)

	// --- Failed tasks modal ---
	const failedCount = allTasksResult.filter((r) => !r.success).length
	logger.debug('tasks result', allTasksResult, 'failed:', failedCount)

	if (mode === SyncStartMode.MANUAL_SYNC && failedCount > 0) {
		const failedTasksInfo: FailedTaskInfo[] = []
		for (let i = 0; i < allTasksResult.length; i++) {
			const result = allTasksResult[i]
			if (!result.success && result.error) {
				const task = result.error.task
				failedTasksInfo.push({
					taskName: getTaskName(task),
					localPath: task.options.localPath,
					errorMessage: result.error.message,
				})
			}
		}
		new FailedTasksModal(ctx.plugin.app, failedTasksInfo).open()
	}

	emitEndSync({ failedCount, showNotice })
}
