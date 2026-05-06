import TwoWaySyncDecider from '../decision/two-way.decider'
import NoopTask from '../tasks/noop.task'
import SkippedTask from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import type { SyncContext, PrepareOutput } from './prepare.stage'

export interface DecideOutput {
	allTasks: BaseTask[]
	substantialTasks: BaseTask[]
	noopTasks: BaseTask[]
	skippedTasks: BaseTask[]
}

export async function decide(
	ctx: SyncContext,
	prep: PrepareOutput,
): Promise<DecideOutput> {
	const syncLike = {
		webdav: ctx.webdav,
		vault: ctx.vault,
		remoteBaseDir: ctx.remoteBaseDir,
		settings: ctx.settings,
	} as any

	const decider = new TwoWaySyncDecider(
		syncLike,
		prep.localDB,
		prep.remoteDB,
		prep.lastSyncDB,
		prep.encryptionKey,
	)

	const allTasks = await decider.decide()

	const noopTasks = allTasks.filter((t) => t instanceof NoopTask)
	const skippedTasks = allTasks.filter((t) => t instanceof SkippedTask)
	const substantialTasks = allTasks.filter(
		(t) => !(t instanceof NoopTask || t instanceof SkippedTask),
	)

	return { allTasks, substantialTasks, noopTasks, skippedTasks }
}
