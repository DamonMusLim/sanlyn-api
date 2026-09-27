# 安卓壳二期说明：外卖响铃 + 扫码拣货

本期前端已经预留 JS 桥，安卓壳需要补这些能力。

## JS 桥

- `LuvSomeApp.scanBarcode()`：打开原生扫码页，扫到码后回调 `window.onNativeScan(code)`。
- `LuvSomeApp.setStaffToken(token)`：前端登录成功和启动主界面时会调用，用于安卓壳保存员工 token。

## 前台服务

- 登录后启动前台服务，每 10 秒请求：
  `/api/db/petstore-takeout?action=unpicked&token=<staffToken>`
- 返回 `count` 变大时：响铃、震动、发系统通知。
- 点通知打开员工端并定位到外卖 tab：`/m/staff#takeout`。
- token 缺失或接口返回 401/403 时停止轮询，等下一次 `setStaffToken`。

## 扫码

- 使用 ML Kit Barcode Scanning bundled model，离线可用。
- 支持一维条码和 QR；本期主要用商品条码。
- 扫码页只负责返回字符串，不在原生层判断是否属于订单。

## 注意

- 原生层不要记录、展示、上传果冻橙 token 或密码。
- 响铃只根据我们接口的 `unpicked.count`，不要直接调用果冻橙。
- 本期“拣货完成”只写我们系统；员工仍需去果冻橙点拣货完成。
