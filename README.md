# agent-map

Mod cho Claude Code: một pane "Sơ đồ tác nhân" đặt cạnh khung chat, cập nhật realtime những gì session đang làm.

- **Session chính** với model đang dùng và trạng thái làm việc.
- **Mỗi tin nhắn là một thẻ**, chứa mọi bước đã chạy để trả lời tin nhắn đó.
- **Chi tiết từng bước**: lệnh Bash/PowerShell kèm stdout và stderr, diff của Edit/Write, nội dung Read, kết quả Grep/Glob, tham số và kết quả của tool MCP.
- **Sub agent** hiện loại, model, prompt đã giao và các bước lồng bên trong.
- **Workflow** gom các agent của một lần chạy vào một thẻ riêng.
- **Mở rộng và thu gọn**: bước đang chạy mở sẵn, xong thì thu lại; tin nhắn mới thu gọn các thẻ cũ.

Đóng pane rồi muốn mở lại thì gõ `/agent-map`.

## Cài đặt

Tại prompt của một session Claude Code trong terminal:

```
/plugin install agent-map --marketplace mrcyclo/claude-agent-map
```

Trả lời `y` để thêm marketplace, rồi chọn phạm vi cài (mặc định là user).

Từ shell:

```bash
claude plugin install agent-map --marketplace mrcyclo/claude-agent-map
```

Trong ứng dụng desktop, nơi `/plugin` không chạy: bấm dấu + cạnh ô nhập, chọn Plugins, Add marketplace với `mrcyclo/claude-agent-map`, rồi Add plugin.
