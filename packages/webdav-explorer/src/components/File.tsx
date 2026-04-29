export interface FolderProps {
	name: string
}

function File(props: FolderProps) {
	return (
		<div class="wde-flex wde-gap-2 wde-items-center wde-max-w-full wde-rounded wde-px-1 wde-cursor-not-allowed wde-opacity-20">
			<svg viewBox="0 0 1024 1024" class="wde-size-10">
				<path d="M186.9,64c-18.4,0-33.4,14.7-33.4,32.6V927.4c0,17.9,15,32.6,33.4,32.6H837.1c18.4,0,33.4-14.7,33.4-32.6V259.5L669.9,64Zm0,0" fill="#e3ecff"/>
				<path d="M669.9,64V226.9c0,17.9,15,32.6,33.4,32.6H870.5Zm0,0" fill="#95a7cd"/>
				<rect x="479.2" y="619.9" width="50" height="48.57" fill="#95a7cd"/>
				<path d="M518.9,363.4h-6.1c-56.3,0-91.3,27.4-104,81.3l-1.3,5.6L450,464.3l1.3-7.1c6.9-36.9,25.7-54.1,59.3-54.1h4.6c28.1,2.6,42.8,15.6,46.2,40.6,2.6,20.4-10.1,40.2-37.7,58.9s-41.2,44-40.1,72.9v20.7h42.8V576.9c-.9-17.7,7.9-32.8,26.1-45,38.3-26.2,56.7-55.7,54.6-87.8C602.9,393.6,573.3,366.5,518.9,363.4Z" fill="#95a7cd"/>
			</svg>
			<span class="wde-truncate wde-flex-1">{props.name}</span>
		</div>
	)
}

export default File
