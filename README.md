# 视频解析 API - Vercel 部署

## 目录结构
`
vercel/
├── api/
│   └── parse.js    # 主解析代码
└── package.json
`

## 部署步骤

### 1. 创建 GitHub 仓库
1. 打开 github.com，登录或注册
2. 点右上角 "+" → New repository
3. 随便起个名字，比如 ideo-parser
4. 创建完成后，把 outputs/vercel/ 文件夹里的内容上传到仓库

### 2. 注册 Vercel
1. 打开 https://vercel.com/sign-up
2. 用 GitHub 账号登录（推荐，点 Continue with GitHub）
3. 授权 Vercel 访问你的仓库

### 3. 导入并部署
1. 登录后点 Add New → Project
2. 找到刚才创建的 ideo-parser 仓库，点 Import
3. 保持默认设置，点 Deploy
4. 等几十秒，部署完成会给你一个地址，类似：
   https://video-parser.vercel.app

### 4. 测试
`
https://video-parser.vercel.app/api/parse?url=抖音分享链接
`
返回格式：
`json
{
  "code": 200,
  "msg": "解析成功",
  "platform": "douyin",
  "data": {
    "type": "video",
    "title": "",
    "author": { "name": "", "id": "", "avatar": "" },
    "cover": "",
    "url": ""
  }
}
`

### 5. Flutter 端修改
把原来请求 bugpkUrl 的地方改成：
`
https://video-parser.vercel.app/api/parse
`

## 支持的平台
- 抖音 ✅（去水印）
- 快手 ✅
- 小红书 ⚠️（有封面无视频地址）
- B站 ❌（API 需要国内 IP）
- 微博 ❓
