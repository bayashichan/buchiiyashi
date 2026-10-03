# ぶち癒やしフェスタ 作業メモ

## GAS（gas/）の変更を本番へ反映する流れ

1. `gas/` の変更をブランチでコミットし、プルリクエストを作って `main` へマージする。
   - `main` へのマージまでは Claude に任せてよい（持ち主の了承済み）。
2. 持ち主が管理画面の「🚀 デプロイ」タブで「GASをデプロイ」を押す。
   - GitHub の `main` にある `gas/code.gs`・`gas/mail_template.html`・`gas/admin_mail_template.html` が
     Apps Script へ反映され、同じ公開URLのまま新しいバージョンになる（`selfUpdateFromRepo`）。
   - デプロイボタンは持ち主が押す。Claude は押さない。

Apps Script エディタへの貼り付けや clasp は使わない。

## 確認メールとLINE通知

申込時の確認メール（`gas/mail_template.html`）と、同じ内容を送るLINE通知
（`gas/code.gs` の `buildLineConfirmationText`）は、片方を直したらもう片方も合わせる。
