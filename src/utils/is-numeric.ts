import { isFinite } from 'lodash-es'

export function isNumeric(val: string | number): boolean {
	return !isNaN(parseFloat(String(val))) && isFinite(Number(val))
}
