# NEXT

**여기까지 됨** — 타겟 점프를 텍스트 검색에서 **CMake가 알려주는 좌표**로 바꿨다.
`backtraceGraph`는 File API 3.14부터 있는 필드인데 여태 안 읽고 있었다.
최소 CMake 버전은 그대로다.

- `fileApi.backtraceChain()`이 노드 사슬을 안쪽부터 훑어 `{file, line, command}`로
  만든다. 디렉토리 top은 줄이 없어 자리로 치지 않고, CMake가 디렉토리마다 사슬을
  새로 시작하므로 **마지막 항목이 항상 사람이 직접 쓴 줄**이다.
- 타겟마다 `declaration`(사람이 쓴 줄)과 `declaredVia`(헬퍼가 끼었을 때 실제
  `add_library`가 돈 자리), 그리고 `dependencySites`(의존성 → 그걸 만든
  `target_link_libraries` 자리)를 싣는다.
- `openCMakeLists`가 그 좌표로 점프하고, 헬퍼가 끼면 실제 실행 위치를 상태
  표시줄에 알린다. 좌표가 없을 때만 예전 정규식으로 떨어진다.
- **Why Is This Linked?** 출력의 각 홉에 `파일:줄`이 붙어 출력 패널에서
  클릭으로 이동된다.

헬퍼 함수 프로젝트로 끝단 검증함: `add_module(sensor)`로 만든 타겟이 이전엔 점프
실패(`add_library(sensor` 문자열이 없으므로), 지금은 `CMakeLists.txt:8`로 정확히
간다. 전체 **137개 통과, 실패 0**(`run.js` 20 → 24).

**다음 할 것** — `compileGroups`를 읽어 **파일별 매크로와 include 경로**를 보여준다.
`defines`(`STM32F407xx`, `USE_HAL_DRIVER`, `BOARD_REV=3`)와 `includes`가 그대로
들어오는 것을 확인했다. 임베디드에서 `#ifdef`가 왜 안 잡히는지 추적할 때 링크 문제
못지않게 자주 막히는 지점이고, 기존 트리 뷰를 재사용하면 작다. 이것도 3.14 필드다.

**그다음** — README의 macOS 전용 명령 병기(`ln -s` → `mklink /J`, `/Applications/...`,
`/tmp/...`, `python3` → `python`). 순환 의존 / 미사용 타겟 표시(그래프는 이미 있음).

**보류** — MSVC 맵 포맷. 제품 바이너리는 리눅스 GNU라 이미 지원된다. 필요해지면
실물 샘플부터. 로드맵의 그래프 뷰(웹뷰)는 지금 트리가 답하는 질문을 더 예쁘게
답할 뿐이라 우선순위 낮음.

**막힌 것** — 확장 호스트 35개는 VS Code 실행 경로가 macOS 전용이라 미실행.
윈도우에 C++ 컴파일러가 없어 진짜 빌드는 불가(configure는 컴파일러 검사 우회로
가능하고, 그 트리로 `include-test` 34개가 전부 돈다).
**실제 회사 프로젝트에 붙여본 적이 아직 없다** — 여전히 제일 큰 미확인 항목.
