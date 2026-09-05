# NEXT

**여기까지 됨** — 대상 플랫폼(윈도우)과 실제 사용 형태가 확인됐다: **윈도우 Visual
Studio에서 개발, 제품 빌드는 리눅스, 툴체인은 GNU 계열.** 그 전제로 소스를 훑어
진짜 문제를 찾았다 — 맵과 빌드 트리가 서로 다른 OS에서 나오는데 `matchTargets`가
`nameOnDisk`를 정확히 키로 삼는다. 재현 확인: 같은 GNU ld 맵에 리눅스 트리는 1개
매칭, 윈도우 트리는 **0개**. 에러 없이 크기 열만 비어 보인다.
앞서 커밋한 조인 테스트 이식성 수정과 CLAUDE.md의 OS 의존성 목록도 이 전제에 맞게
정정했다(`isLibraryFragment`가 MSVC `.lib`을 놓친다고 적었던 것은 오독이었다 —
정상 인식된다).

**다음 할 것** — `matchTargets`에 **폴백 매칭**을 넣는다. 정확 일치를 먼저 시도하고,
실패했을 때만 `lib` 접두사와 확장자를 벗긴 어간으로 비교한다
(`libdemocore.a` → `democore` ← `democore.lib`). CMake 타겟 이름은 프로젝트 안에서
유일하고 `nameOnDisk`가 거기서 파생되므로 오탐 위험은 낮다. 정확 일치를 이기지
않도록 순서를 지키는 게 핵심. 함께 `make-fixture.py`가 플랫폼별 이름을 낼 수 있게
하고, 크로스 OS 조인(윈도우 트리 + GNU 맵) 케이스를 테스트에 추가한다.

**그다음** — `demanglerCommand` 기본값 문제. 리눅스에서 만든 맵의 GCC 심볼을
윈도우에서 풀어야 하는데 윈도우엔 `c++filt`가 없다. 기본값 탐색을 넓히거나
(`arm-none-eabi-c++filt` 등) README에 설정법을 적는다.

**막힌 것** — 확장 호스트 35개는 VS Code 실행 경로가 macOS 전용이라 미실행.
`include-test`는 28개가 실제 빌드 트리를 요구한다(합성 픽스처로 풀리는지 미검증).
윈도우에 C++ 컴파일러가 없어 진짜 빌드는 불가. README의 설치·통합테스트 명령도
macOS 전용이다(`ln -s`, `/Applications/...`, `/tmp/...`, `python3` → `python`).
