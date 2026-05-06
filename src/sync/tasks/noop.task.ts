import { BaseTask } from './task.interface'

export default class NoopTask extends BaseTask {
	type = 'noop'

	exec() {
		return {
			success: true,
		} as const
	}
}
