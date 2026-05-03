declare module 'blob-polyfill' {}
declare module 'core-js/stable' {}

declare module '*.css' {
	const content: string
	export default content
}
