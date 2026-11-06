# Lysel

轻量多平台多账户机器人框架。

## 运行

```bash
npm install
npm start
```

首次启动会在 `data/` 下生成全局配置与账户目录骨架。

## 目录

```
core/     主程序
plugins/  插件
data/     运行时数据，按账户隔离
```

## 账户

在 `data/accounts/<id>/account.json` 配置平台与凭据，支持多账户并存。

## 插件

插件放在 `plugins/<name>/`，安装时把 `config.example.json` 复制到该账户的插件数据目录。
