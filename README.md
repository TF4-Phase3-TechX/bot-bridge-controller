# Contribution bridge controller

A chủ động gửi một PR và một head SHA qua notifier `workflow_dispatch`. Mở PR, sửa code, schedule hay B event không tự chuyển commit mới sang B. B quyết định review/merge; controller tiếp tục đồng bộ lịch sử đã chấp nhận về A và phản hồi review/comment.

Controller xác minh run notifier qua GitHub API: đúng repo/workflow/default branch, event manual, run-name khớp PR + SHA, lần chạy đầu, thành công, không quá một giờ và người chạy hiện có Write. Không tin actor/SHA chỉ vì caller có Dispatch key. PR phải open, ready, cùng repo và đúng base/head; nếu SHA thay đổi trước transport, yêu cầu gửi lại. Re-run job cũ không được dùng để gửi code; chọn Run workflow mới.

App Sync cần Contents/Pull requests/Workflows write và **Actions read**. App Transport giữ Contents/Pull requests write, không Workflows write. App Dispatch chỉ Actions write tại controller. Transport keys chỉ nằm ở controller; không checkout/chạy code contribution. Default branch A phải được SRE bảo vệ; GitHub Free với private repo không cung cấp rulesets để kiểm chứng ranh giới này.

`bridge.config.json` khai báo các cặp; `sourceBranch`/`targetBranch` mặc định main, hỗ trợ main hoặc dev. Controller luôn chạy từ main. Notifier manual luôn chạy từ default branch A, kể cả contribution base là dev. Không dùng source PR branch làm workflow ref.

Incoming branch B chỉ cập nhật khi có submission hợp lệ cho đúng PR. Không force-push B, không merge B. B có thể thêm commit; divergence cần xử lý riêng. Khi B merge, A chỉ đóng nếu lịch sử gốc và merge result đã được đồng bộ; commit chưa gửi vẫn được giữ. B reject không đóng A nếu A còn revision mới chưa được xét.

Schedule 6 giờ/dispatch controller không có inputs chỉ reconcile; không gửi PR mới. A comment được đồng bộ vào lần reconcile tiếp theo. Job policy chạy tests không có App keys; reconcile kiểm tra code trước khi mint token. Giữ BRIDGE_ENABLED=false khi rollout, deploy controller trước notifier, kiểm App permissions và guard các job ứng dụng chỉ chạy tại B trước khi đồng bộ về A.

```bash
node --check scripts/pr-bridge.mjs
node --test tests/*.test.mjs
```

Production phải chặn developer cập nhật main/dev tại A, chặn Transport App ghi/merge protected base tại B, và chỉ SRE quản lý controller. Disable workflow tại A là trạng thái vận hành, không chặn workflow mới lần đầu: cần repository guard tại từng job B-only. Disable không hủy run đã queued/running.
