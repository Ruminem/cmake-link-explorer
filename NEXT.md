# NEXT

**여기까지 됨** — 맵↔타겟 조인 테스트가 macOS에서만 통과하던 것을 고쳐, cmake 없이
어느 플랫폼에서든 돌게 했다(`test/fixture/build` 사용, 제품 코드는 안 건드림).
윈도우에서 87개 통과, 실패 0. 그 뒤 **이 익스텐션의 대상 플랫폼이 윈도우**라는 것이
확인돼, 그 전제로 소스를 훑어 OS 의존성을 정리했다. CLAUDE.md에 대상 플랫폼 절을 추가.

**다음 할 것** — 먼저 **대상 툴체인을 정한다(MSVC냐 GNU 계열이냐).** 이게 아래 항목의
크기를 완전히 바꾼다. GNU 계열(MinGW, arm-none-eabi-gcc)이면 1~3번은 이미 동작하므로
할 일은 4번과 문서뿐이다. MSVC라면 1번이 큰 작업이 된다.

발견된 OS 의존성:

1. `mapFile.detectFormat` — GNU ld / Apple ld64만 인식. MSVC `link.exe /MAP` 미지원이라
   MSVC를 쓰면 Linker Map 기능이 통째로 죽는다. (실물 샘플 없이 포맷을 추측해
   넣지 않는다는 원칙은 유지 — lld를 뺀 것과 같은 이유)
2. `demanglerCommand` 기본값 `c++filt` — 윈도우에 없고, MSVC 맹글링은 스킴이 달라
   `c++filt`가 있어도 못 푼다. `undname` 계열이 필요하다.
3. `fileApi.isLibraryFragment` — `-l`/`-framework`로 판정(GCC/Clang 관례).
   MSVC는 `foo.lib`으로 넘어와 라이브러리로 인식되지 않는다.
4. `test/make-fixture.py`가 `lib{}.dylib`/`lib{}.a`를 하드코딩 — 조인 테스트가 이걸
   쓰므로 윈도우 이름(`.dll`/`.lib`)으로는 조인이 한 번도 검증되지 않는다.
   픽스처가 플랫폼별 이름을 낼 수 있게 하고 윈도우 케이스를 추가해야 한다.

**막힌 것** — 확장 호스트 35개는 VS Code 실행 경로가 macOS 전용이라 미실행.
`include-test`는 28개가 여전히 실제 빌드 트리를 요구한다(합성 픽스처로 풀리는지
미검증). 윈도우에 C++ 컴파일러가 없어 진짜 빌드는 불가. README의 설치·통합테스트
명령도 macOS 전용이다(`ln -s`, `/Applications/...`, `/tmp/...`, `python3` → `python`).
