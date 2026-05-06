import { chunk } from 'lodash-es'
import { emitSyncError, emitSyncProgress } from '~/events'
import i18n from '~/i18n'
import getTaskName from '~/utils/get-task-name'
import { is503Error } from '~/utils/is-503-error'
import logger from '~/utils/logger'
import NoopTask from '../tasks/noop.task'
import CleanRecordTask from '../tasks/clean-record.task'
import { BaseTask, TaskError, TaskResult } from '../tasks/task.interface'
import { handle503Error } from './shared'
import type { SyncContext } from './prepare.stage'

export interface ExecuteOutput {
  allTasksResult: TaskResult[]
}

async function executeWithRetry(
  task: BaseTask,
  isCancelled: () => boolean,
): Promise<TaskResult> {
  while (true) {
    if (isCancelled()) {
      return {
        success: false,
        error: new TaskError(i18n.t('sync.cancelled'), task),
      }
    }
    const taskResult = await task.exec()
    if (!taskResult.success && is503Error(taskResult.error)) {
      await handle503Error(60000, isCancelled)
      if (isCancelled()) {
        return {
          success: false,
          error: new TaskError(i18n.t('sync.cancelled'), task),
        }
      }
      continue
    }
    return taskResult
  }
}

async function execTasks(
  tasks: BaseTask[],
  totalDisplayableTasks: BaseTask[],
  allCompletedTasks: BaseTask[],
  isCancelled: () => boolean,
): Promise<TaskResult[]> {
  const res: TaskResult[] = []
  const tasksToDisplay = tasks.filter(
    (t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
  )

  logger.debug('Starting to execute sync tasks', {
    totalTasks: tasks.length,
    displayedTasks: tasksToDisplay.length,
    totalDisplayableTasks: totalDisplayableTasks.length,
    alreadyCompleted: allCompletedTasks.length,
  })

  for (let i = 0; i < tasks.length; ++i) {
    const task = tasks[i]
    if (isCancelled()) {
      emitSyncError(new TaskError(i18n.t('sync.cancelled'), task))
      break
    }

    logger.debug(`Executing task [${i + 1}/${tasks.length}] ${task.localPath}`, {
      taskName: getTaskName(task),
      taskPath: task.localPath,
    })

    const taskResult = await executeWithRetry(task, isCancelled)

    logger.debug(`Task completed [${i + 1}/${tasks.length}] ${task.localPath}`, {
      taskName: getTaskName(task),
      taskPath: task.localPath,
      result: taskResult,
    })

    res[i] = taskResult
    if (!(task instanceof NoopTask || task instanceof CleanRecordTask)) {
      allCompletedTasks.push(task)
      emitSyncProgress(totalDisplayableTasks.length, allCompletedTasks)
    }
  }

  const successCount = res.filter((r) => r.success).length
  logger.debug('All tasks execution completed', {
    totalTasks: tasks.length,
    successCount,
    failedCount: tasks.length - successCount,
  })

  return res
}

export async function execute(
  ctx: SyncContext,
  confirmedTasks: BaseTask[],
): Promise<ExecuteOutput> {
  const chunkSize = 200
  const taskChunks = chunk(confirmedTasks, chunkSize)
  const allTasksResult: TaskResult[] = []

  const totalDisplayableTasks = confirmedTasks.filter(
    (t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
  )

  const allCompletedTasks: BaseTask[] = []

  for (const taskChunk of taskChunks) {
    const chunkResult = await execTasks(
      taskChunk,
      totalDisplayableTasks,
      allCompletedTasks,
      ctx.isCancelled,
    )
    allTasksResult.push(...chunkResult)

    if (ctx.isCancelled()) break
  }

  return { allTasksResult }
}
