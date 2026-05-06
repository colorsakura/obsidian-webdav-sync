import { Notice, moment } from 'obsidian'
import { onCancelSync } from '~/events'
import i18n from '~/i18n'
import breakableSleep from '~/utils/breakable-sleep'

/**
 * 等待 60 秒后重试，显示 Notice 提示下次重试时间。
 * 从 NutstoreSync.handle503Error 提取，参数化 isCancelled。
 */
export async function handle503Error(
	waitMs: number,
	isCancelled: () => boolean,
) {
	const now = Date.now()
	const startAt = now + waitMs
	new Notice(
		i18n.t('sync.requestsTooFrequent', {
			time: (moment as any)(startAt).format('HH:mm:ss'),
		}),
	)
	await breakableSleep(onCancelSync(), startAt - now)
}
