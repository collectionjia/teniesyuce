const http = require('http')

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) })
        } catch (e) {
          resolve({ status: res.statusCode, data })
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

;(async () => {
  const body = JSON.stringify({ account: 'admin@demo.com', password: '123456' })
  const login = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body)
  if (!login.data?.token) {
    console.error('login failed', login)
    process.exit(1)
  }
  const report = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/admin/daily-report',
    method: 'GET',
    headers: { Authorization: `Bearer ${login.data.token}` },
  })
  console.log(JSON.stringify(report, null, 2))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
