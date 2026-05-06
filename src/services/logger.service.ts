import { moment } from 'obsidian'
import type { LogObject } from 'consola'
import { IN_DEV } from '~/consts'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

export class LoggerService {
	logs: unknown[][] = []

	constructor(_plugin: NutstorePlugin) {
		if (IN_DEV) {
			logger.addReporter({
				log: (logObj: LogObject) => {
					const log = [
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(moment as any)(logObj.date).format('YYYY-MM-DD HH:mm:ss'),
						logObj.type,
						logObj.args,
					]
					this.logs.push(log)
				},
			})
		} else {
			logger.setReporters([
				{
					log: (logObj: LogObject) => {
						this.logs.push([logObj as unknown])
					},
				},
			])
		}
	}

	clear() {
		this.logs = []
	}
}
