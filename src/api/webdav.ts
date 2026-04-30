import { XMLParser } from 'fast-xml-parser'
import { isNil, partial } from 'lodash-es'
import { basename, join } from 'path-browserify'
import { FileStat } from 'webdav'

import { is503Error } from '~/utils/is-503-error'
import logger from '~/utils/logger'
import requestUrl from '~/utils/request-url'
import sleep from '~/utils/sleep'

interface WebDAVPropstat {
	prop: {
		displayname: string
		resourcetype: { collection?: any }
		getlastmodified?: string
		getcontentlength?: string
		getcontenttype?: string
	}
	status: string
}

interface WebDAVResponse {
	multistatus: {
		response: Array<{
			href: string
			propstat: WebDAVPropstat | WebDAVPropstat[]
		}>
	}
}

function extractNextLink(linkHeader: string): string | null {
	const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
	return matches ? matches[1] : null
}

/**
 * 从可能为数组的 propstat 中选择最佳项。
 * 优先选择 status 包含 200 的项，若没有则取第一项。
 */
function getBestPropstat(
	propstat: WebDAVPropstat | WebDAVPropstat[],
): WebDAVPropstat {
	if (Array.isArray(propstat)) {
		return propstat.find((ps) => ps.status?.includes('200')) || propstat[0]
	}
	return propstat
}

function convertToFileStat(
	serverBase: string,
	item: { href: string; propstat: WebDAVPropstat | WebDAVPropstat[] },
): FileStat {
	const props = getBestPropstat(item.propstat).prop
	const isDir = !isNil(props.resourcetype?.collection)
	const href = decodeURIComponent(item.href)
	const filename =
		serverBase === '/' ? href : join('/', href.replace(serverBase, ''))

	return {
		filename,
		basename: basename(filename),
		lastmod: props.getlastmodified || '',
		size: props.getcontentlength ? parseInt(props.getcontentlength, 10) : 0,
		type: isDir ? 'directory' : 'file',
		etag: null,
		mime: props.getcontenttype,
	}
}

export async function getDirectoryContents(
	token: string,
	path: string,
	endpoint: string,
): Promise<FileStat[]> {
	const contents: FileStat[] = []
	path = path.split('/').map(encodeURIComponent).join('/')
	if (!path.startsWith('/')) {
		path = '/' + path
	}
	// 避免 endpoint 末尾与 path 开头都是 / 时出现双斜杠
	let currentUrl = endpoint.replace(/\/+$/, '') + path

	while (true) {
		try {
			const response = await requestUrl({
				url: currentUrl,
				method: 'PROPFIND',
				headers: {
					Authorization: `Basic ${token}`,
					'Content-Type': 'application/xml',
					Depth: '1',
				},
				body: `<?xml version="1.0" encoding="utf-8"?>
	        <propfind xmlns="DAV:">
	          <prop>
	            <displayname/>
	            <resourcetype/>
	            <getlastmodified/>
	            <getcontentlength/>
	            <getcontenttype/>
	          </prop>
	        </propfind>`,
			})
			if (response.status >= 400) {
				throw new Error(`${response.status}: ${response.text}`)
			}
			const parseXml = new XMLParser({
				attributeNamePrefix: '',
				removeNSPrefix: true,
				parseTagValue: false,
				numberParseOptions: {
					eNotation: false,
					hex: true,
					leadingZeros: true,
				},
				processEntities: false,
			})
			const result: WebDAVResponse = parseXml.parse(response.text)
			const items = Array.isArray(result.multistatus.response)
				? result.multistatus.response
				: [result.multistatus.response]

			// 跳过第一个条目（当前目录）
			contents.push(
				...items
					.slice(1)
					.map(partial(convertToFileStat, new URL(endpoint).pathname)),
			)

			const linkHeader = response.headers['link'] || response.headers['Link']
			if (!linkHeader) {
				break
			}

			const nextLink = extractNextLink(linkHeader)
			if (!nextLink) {
				break
			}
			const nextUrl = new URL(nextLink)
			nextUrl.pathname = decodeURI(nextUrl.pathname)
			currentUrl = nextUrl.toString()
		} catch (e) {
			if (is503Error(e as Error)) {
				logger.error('503 error, retrying...')
				await sleep(60_000)
				continue
			}
			// jianguoyun returns 409 AncestorsNotFound when the directory
			// (or its ancestors) does not exist. Treat as empty directory.
			if (
				e instanceof Error &&
				(e.message.startsWith('409') || e.message.startsWith('404'))
			) {
				return []
			}
			throw e
		}
	}

	return contents
}
