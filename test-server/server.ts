/**
 * WebDAV 测试服务器
 *
 * 用于本地测试 obsidian-webdav-sync 加密功能
 *
 * 启动: bun run test-server/server.ts
 * 地址: http://localhost:1900/
 * 认证: admin / admin
 *
 * 自定义:
 *   PORT=8080 WEBDAV_USER=user WEBDAV_PASS=pass bun run test-server/server.ts
 */

import { v2 as webdav } from 'webdav-server'
import { join } from 'path'

const PORT = parseInt(process.env.PORT || '1900')
const HOST = process.env.HOST || '127.0.0.1'
const DATA_DIR = join(import.meta.dir, 'data')
const USER = process.env.WEBDAV_USER || 'admin'
const PASS = process.env.WEBDAV_PASS || 'admin'

// 用户管理
const userManager = new webdav.SimpleUserManager()
userManager.addUser(USER, PASS, true)

// 权限管理
const privilegeManager = new webdav.SimplePathPrivilegeManager()

const server = new webdav.WebDAVServer({
  hostname: HOST,
  httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'WebDAV Test'),
  privilegeManager,
})

// 挂载物理文件系统到 /
server.setFileSystemSync('/', new webdav.PhysicalFileSystem(DATA_DIR))

server.start(PORT, () => {
  console.log(`\n🔐 WebDAV 测试服务器已启动\n`)
  console.log(`   Obsidian 插件配置:`)
  console.log(`   WebDAV 地址: http://${HOST}:${PORT}/`)
  console.log(`   用户名:      ${USER}`)
  console.log(`   密码:        ${PASS}`)
  console.log(`   数据目录:    ${DATA_DIR}`)
  console.log()
})
