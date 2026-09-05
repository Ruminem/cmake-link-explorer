# NEXT

**여기까지 됨** — 후보 2번(파일별 매크로 / include 경로)을 넣었다. **144개 통과, 실패 0.**

**What Is This File Compiled With?** 명령을 추가했다. 소스 파일에서 부르면 그 파일의
실효 매크로와 include 경로를 출력 패널에 쓴다. `compileGroups`는 File API 3.14부터
있는 필드라 최소 CMake 버전은 그대로다.

- `fileApi`가 `compileGroups`를 모델에 싣는다 — 언어, 표준, `defines`, `includes`
  (`isSystem` 포함), `sourceIndexes`.
- `includeResolver.compileSettingsForFile()`이 파일 → 타겟 → 컴파일 그룹으로 내려간다.
- 값어치는 **상속된 설정이 보인다**는 데 있다. 직접 만든 프로젝트로 확인: `board.cpp`가
  자기 `BOARD_REV=3`뿐 아니라 `hal`이 `PUBLIC`으로 붙인 `STM32F407xx`,
  `USE_HAL_DRIVER`까지 함께 보여준다. CMakeLists를 읽어서는 안 나오는 답이다.
- **헤더는 어느 컴파일 그룹에도 없다.** 타겟에 언어 그룹이 하나면 그걸 보여주되
  `exact: false`로 표시하고, C/C++가 섞인 타겟이면 아무것도 고르지 않는다.
  찍으면 답을 지어내는 것이라서.
- 실제 CMake가 `target_include_directories(x PUBLIC .)`를 `<dir>/.`로 쓰는 것을
  발견해 표시할 때 끝의 `/.`을 떼도록 했다.

**다음 할 것** — 후보 3번: **순환 의존 / 미사용 타겟 표시.** 그래프는 이미 모델에
있으니 탐지 자체는 작다. 순환은 링크 순서를 깨고, 미사용 타겟은 빌드 시간만 먹는다.
README 로드맵에도 원래 있던 항목이다.

**그다음** — 후보 4번: 윈도우 트리 vs 리눅스 트리 비교. 두 코드모델에서 타겟·매크로·
include가 어긋난 곳을 짚어 "윈도우에선 되는데 리눅스에서 깨지는" 부류를 빌드 전에
잡는다. 이번에 넣은 `compileGroups`가 그 비교의 재료가 된다. 두 트리가 같은 머신에
있어야 하고 중간 규모다.

**그다음** — README의 macOS 전용 명령 병기(`ln -s` → `mklink /J`, `/Applications/...`,
`/tmp/...`, `python3` → `python`).

**보류** — MSVC 맵 포맷. 제품 바이너리는 리눅스 GNU라 이미 지원된다. 필요해지면
실물 샘플부터. 로드맵의 그래프 뷰(웹뷰)는 지금 트리가 답하는 질문을 더 예쁘게 답할
뿐이라 우선순위 낮음.

**막힌 것** — 확장 호스트 35개는 VS Code 실행 경로가 macOS 전용이라 미실행.
새로 넣은 `compileSettings` 명령도 확장 호스트 테스트가 없다(로직은 40개로 덮음).
윈도우에 C++ 컴파일러가 없어 진짜 빌드는 불가.
**실제 회사 프로젝트에 붙여본 적이 아직 없다** — 여전히 제일 큰 미확인 항목.
