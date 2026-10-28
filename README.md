# 프로젝트 관리 (핸썬)

프로젝트 개요와 하드웨어 발주·납품 내역을 기록하고 보는 웹 도구입니다.

- 화면: 이 저장소 (GitHub Pages)
- 저장: 관리자 구글 계정의 스프레드시트 + Apps Script 웹 앱 (`apps-script/`)
- 공동 비밀번호가 맞아야만 읽고 쓸 수 있습니다. 이 저장소에는 데이터와 비밀번호가 들어 있지 않습니다.

## 고칠 때

- `index.html` 아래쪽의 `Version 01` 을 한 단계 올리고, `sw.js` 의 `VERSION` 도 같이 올립니다.
- Apps Script를 고친 뒤에는 `apps-script` 폴더에서 `clasp push` 후 기존 배포를 새 버전으로 바꿉니다 (`clasp deploy -i <배포 ID>`). 그래야 웹 앱 주소가 그대로 유지됩니다.
- 현 상황 선택지는 `apps-script/Code.js` 맨 위 `STATUSES_DEFAULT` 를 고치거나, Apps Script 프로젝트 설정의 스크립트 속성에 `STATUSES` (쉼표로 구분)를 넣어 바꿉니다.
