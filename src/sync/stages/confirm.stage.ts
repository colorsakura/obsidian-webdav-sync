import { Notice, Platform, normalizePath } from 'obsidian'
import { dirname } from 'path-browserify'
import DeleteConfirmModal from '~/components/DeleteConfirmModal'
import TaskListConfirmModal from '~/components/TaskListConfirmModal'
import { emitSyncError, emitStartSync } from '~/events'
import i18n from '~/i18n'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import CleanRecordTask from '../tasks/clean-record.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import NoopTask from '../tasks/noop.task'
import PushTask from '../tasks/push.task'
import RemoveLocalTask from '../tasks/remove-local.task'
import SkippedTask from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import { SyncStartMode } from '../index'
import type { SyncContext, PrepareOutput } from './prepare.stage'
import type { DecideOutput } from './decide.stage'

export interface ConfirmInput {
	mode: SyncStartMode
	showNotice: boolean
}

export interface ConfirmOutput {
	confirmedTasks: BaseTask[]
}

export async function confirm(
	ctx: SyncContext,
	prep: PrepareOutput,
	dec: DecideOutput,
	opts: ConfirmInput,
): Promise<ConfirmOutput | null> {
	let confirmedTasks = dec.substantialTasks
	const { mode, showNotice } = opts

	// --- confirmBeforeSync Modal ---
	const firstTaskIdxNeedingConfirmation = confirmedTasks.findIndex(
		(t) => !(t instanceof CleanRecordTask),
	)

	if (ctx.isCancelled()) {
		emitSyncError(new Error(i18n.t('sync.cancelled')))
		return null
	}

	if (
		showNotice &&
		ctx.settings.confirmBeforeSync &&
		firstTaskIdxNeedingConfirmation > -1
	) {
		const confirmExec = await new TaskListConfirmModal(
			ctx.plugin.app,
			confirmedTasks,
		).open()
		if (confirmExec.confirm) {
			confirmedTasks = confirmExec.tasks
		} else {
			emitSyncError(new Error(i18n.t('sync.cancelled')))
			return null
		}
	}

	// --- auto-sync 删除确认 + 重上传逻辑 ---
	if (
		mode === SyncStartMode.AUTO_SYNC &&
		ctx.settings.confirmBeforeDeleteInAutoSync
	) {
		const removeLocalTasks = confirmedTasks.filter(
			(t) => t instanceof RemoveLocalTask,
		) as RemoveLocalTask[]
		if (removeLocalTasks.length > 0) {
			new Notice(i18n.t('deleteConfirm.warningNotice'), 3000)
			const { tasksToDelete, tasksToReupload } = await new DeleteConfirmModal(
				ctx.plugin.app,
				removeLocalTasks,
			).open()

			const mkdirTasksMap = new Map<string, MkdirRemoteTask>()
			const pushTasks: PushTask[] = []
			const remoteExistsCache = new Set<string>()

			const markPathAndParentsAsExisting = (remotePath: string) => {
				let current = remotePath
				while (
					current &&
					current !== '.' &&
					current !== '' &&
					current !== '/'
				) {
					if (remoteExistsCache.has(current)) break
					remoteExistsCache.add(current)
					current = stdRemotePath(dirname(current))
				}
			}

			const ensureParentDir = async (localPath: string, remotePath: string) => {
				const parentLocalPath = normalizePath(dirname(localPath))
				const parentRemotePath = stdRemotePath(dirname(remotePath))

				if (
					parentLocalPath === '.' ||
					parentLocalPath === '' ||
					parentLocalPath === '/'
				)
					return

				if (mkdirTasksMap.has(parentRemotePath)) return

				const existsInOriginal = dec.allTasks.some(
					(t) =>
						t instanceof MkdirRemoteTask && t.remotePath === parentRemotePath,
				)
				if (existsInOriginal) return

				const existsInConfirmed = confirmedTasks.some(
					(t) =>
						t instanceof MkdirRemoteTask && t.remotePath === parentRemotePath,
				)
				if (existsInConfirmed) return

				if (remoteExistsCache.has(parentRemotePath)) return

				try {
					await ctx.webdav.stat(parentRemotePath)
					markPathAndParentsAsExisting(parentRemotePath)
				} catch (e) {
					const mkdirTask = new MkdirRemoteTask({
						vault: ctx.vault,
						webdav: ctx.webdav,
						remoteBaseDir: ctx.remoteBaseDir,
						remotePath: parentRemotePath,
						localPath: parentLocalPath,
						encryptionKey: prep.encryptionKey,
						plugin: ctx.plugin,
					})
					mkdirTasksMap.set(parentRemotePath, mkdirTask)
				}
			}

			for (const task of tasksToReupload) {
				const stat = await statVaultItem(ctx.vault, task.localPath)
				if (!stat) continue

				await ensureParentDir(task.localPath, task.remotePath)

				if (stat.isDir) {
					const mkdirTask = new MkdirRemoteTask(task.options)
					mkdirTasksMap.set(task.remotePath, mkdirTask)
				} else {
					const pushTask = new PushTask(task.options)
					pushTasks.push(pushTask)
				}
			}

			const mkdirTasks = Array.from(mkdirTasksMap.values())
			const deleteTaskSet = new Set(tasksToDelete)

			for (const reuploadTask of tasksToReupload) {
				let currentPath = normalizePath(reuploadTask.localPath)
				while (
					currentPath &&
					currentPath !== '.' &&
					currentPath !== '' &&
					currentPath !== '/'
				) {
					currentPath = normalizePath(dirname(currentPath))
					if (currentPath === '.' || currentPath === '' || currentPath === '/')
						break
					for (const deleteTask of deleteTaskSet) {
						if (deleteTask.localPath === currentPath) {
							deleteTaskSet.delete(deleteTask)
							break
						}
					}
				}
			}

			const otherTasks: BaseTask[] = []
			const deleteTasks: RemoveLocalTask[] = []

			for (const t of confirmedTasks) {
				if (!(t instanceof RemoveLocalTask)) {
					otherTasks.push(t)
				} else if (deleteTaskSet.has(t)) {
					deleteTasks.push(t)
				}
			}

			confirmedTasks = [
				...mkdirTasks,
				...otherTasks,
				...pushTasks,
				...deleteTasks,
			]
		}
	}

	// --- 大量任务提示 ---
	if (confirmedTasks.length > 500 && Platform.isDesktopApp) {
		new Notice(i18n.t('sync.suggestUseClientForManyTasks'), 5000)
	}

	// --- 进度 Modal ---
	const hasSubstantialTask = confirmedTasks.some(
		(task) =>
			!(
				task instanceof NoopTask ||
				task instanceof CleanRecordTask ||
				task instanceof SkippedTask
			),
	)
	if (showNotice && hasSubstantialTask) {
		ctx.plugin.progressService.showProgressModal()
	}

	// --- 发出开始同步事件 ---
	emitStartSync({ showNotice })

	return { confirmedTasks }
}
