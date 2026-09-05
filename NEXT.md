# NEXT

**여기까지 됨** — 세션 내내 막혀 있던 두 가지가 풀렸다.

**확장 호스트 테스트 35개가 윈도우에서 전부 통과했다.** 막힌 이유는 macOS 실행 경로
하나였고, 거기에 더해 **VS Code가 켜져 있으면 거부당한다**는 것을 알아냈다
(`--user-data-dir`/`--extensions-dir`로 별도 프로필을 주면 평소 창을 닫지 않아도 된다).
그래서 오늘 만든 것들이 실제 확장 호스트에서 검증됐다 — 명령 등록,
backtrace 점프(`openCMakeLists jumps to the add_library line`),
내장 디맹글러(`an ld64 map loads and demangles C++ names`), 맵↔타겟 조인까지.
**윈도우 총 195개 통과** (단위 160 + 확장 호스트 35).

**VSIX 패키징이 된다.** `npx @vscode/vsce package`로 14개 파일 59.1 KB가 나오고,
`code --install-extension`으로 설치까지 확인했다(`local.cmake-link-explorer@0.1.0`).
`.vscodeignore`로 `CLAUDE.md`/`NEXT.md` 등을 걷어냈고 `repository`/`bugs`/`keywords`를
채웠다.

**README의 macOS 전용 명령을 전부 병기했다** — 설치(정션 `mklink /J` + VSIX 경로),
확장 호스트 테스트(윈도우 PowerShell + 별도 프로필 필요 이유), `python3` → `python`
(윈도우의 `python3`는 스토어 스텁으로 가는 경우가 많다), `bootstrap.sh`가 없는 윈도우용
대체 절차.

**다음 할 것** — GitHub Release에 `.vsix`를 올린다. 그러면 받는 쪽은 확장 탭
`...` → VSIX에서 설치로 끝난다. **회사 장비에 깔 때 이게 제일 편하다.**

**그다음, 그리고 진짜 남은 것** — **실제 회사 프로젝트에 붙여보기.** 이제 설치가
쉬워졌고 확장 호스트 검증도 끝났으니 걸림돌이 없다. 이번 세션에 잡은 버그 다섯 개가
전부 "실제로 돌려보니 드러난" 것들이었다. 샘플 프로젝트가 아닌 진짜 프로젝트에서
무엇이 나오는지가 다음 세션의 값어치다.

**보류** — 마켓플레이스 게시(B안). 퍼블리셔 ID, 128×128 PNG 아이콘, Azure DevOps
계정과 PAT가 필요하다. 지금은 VSIX로 충분하다고 판단했다.
MSVC / lld 맵 포맷은 실물 샘플이 생기면. 그래프 뷰(웹뷰)는 우선순위 낮음.

**막힌 것** — 없음. 윈도우에서 돌릴 수 있는 검증은 전부 돌아간다.
윈도우에 C++ 컴파일러가 없어 진짜 빌드는 못 하지만, configure는 컴파일러 검사
우회로 되고 테스트는 그걸로 전부 돈다.
