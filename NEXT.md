# NEXT

**여기까지 됨** — **Build Time 뷰가 붙었고 돈다.** 빌드 후 뷰를 열면 느린 단계가
타겟별로 묶여 시간과 함께 나온다. 파서(`src/buildLog.js`), 뷰(`src/timeTree.js`),
명령 3개, Targets 뷰의 시간 열, README 두 판까지. 아직 게시 안 했다 — **다음 릴리스가
0.3.0이다.**

**그 전** — **0.2.2를 마켓플레이스에 올렸다.** 상태 표시줄이 돌지도 않은 빌드 트리
탐색 결과를 말하던 것, 저장에 실패한 링크 편집이 "저장됨"이라고 답하던 것. 태그는
`v0.2.2`. 그 전 0.2.1에서는 조용히 틀리던 것 여섯 개를 잡았다(아래).

## Build Time

**왜 별도 확장이 아니라 여기에 넣었나** — 어려운 부분이 이미 다 있었다. 빌드
디렉터리 해석, `loadModel()`, 그리고 무엇보다 **경로를 타겟으로 되돌리는 조인**.
ninja가 주는 건 `libs/engine/CMakeFiles/engine.dir/engine.cpp.obj`일 뿐이고, 이걸
타겟 engine으로 바꾸는 규칙은 `mapFile.matchTargets`가 이미 값을 치른 것과 같은
문제다. `artifactStem`은 실제로 재사용했다(중복 정의하면 둘이 어긋난다).

그리고 합쳐야만 나오는 말이 실제로 나왔다. Targets 행 하나에 **개수 · 크기 · 시간**이
같이 붙고, `sortTargets`에 `size` 옆에 `time`이 생겼다. 별도 확장이면 못 할 변경이다.

**픽스처는 진짜다** — `test/ninja/*.ninja_log`는 이 컴퓨터의 ninja + MinGW가
`test/sample-project`를 빌드해서 만든 실물이다. 포맷을 추측하지 않는다는 규칙대로
문서만 보고 쓰지 않고 먼저 빌드해서 뽑았고, **그 덕에 세 가지를 안 틀렸다.**

1. **한 edge가 출력을 여러 개 가진다.** `librender_core.dll`과 `.dll.a`가 start·end·
   mtime·hash가 **전부 같은** 두 줄로 들어 있다. 출력 단위로 더하면 **링크 한 번을
   두 번 청구한다.** 그래서 전부 출력이 아니라 edge 단위로 센다.
2. **ninja는 append만 하고 지우지 않는다.** 증분 빌드 후 같은 출력이 두 줄이 된다
   (engine.cpp.obj: 콜드 203ms, 웜 90ms). **마지막 줄이 정답이다.**
3. **한 파일 안에 여러 번의 빌드가 섞인다.** 구분 표식이 없고 `end` 열이 앞줄보다
   작아지는 지점이 새 빌드의 시작이다.

2번 덕에 좋은 성질이 따라온다. "마지막 빌드"가 아니라 "출력별 마지막 줄"을 쓰면
풀빌드 한 번 뒤에 증분을 아무리 돌려도 **모든 타겟의 시간이 남아 있다.**

**뷰에서 신경 쓴 것**

- **알아서 열린다.** `.ninja_log`는 빌드 디렉터리 최상단에 있으니 이미 고른 트리에서
  바로 찾는다. 맵과 달리 사용자가 파일을 고를 필요가 없다.
- **닫으면 닫힌 채로 있다.** `logDismissed` 플래그가 없으면 다음 reload가 곧바로
  다시 열어서 Close 명령이 고장 난 것처럼 보인다. 확장 호스트 테스트가 이걸 본다.
- **맨 윗줄에 숫자가 둘이다.** 마지막 빌드의 실제 소요(390ms)와 edge 시간의
  합(11.6초). 병렬로 도니 둘은 다르고, **빨라졌다는 건 앞 숫자를 두고 하는 말이다.**

**샘플에서 바로 하나 나왔다** — 11.6초 중 **8.8초가 `ar` 아카이빙**이다. 컴파일
전체가 2.1초인데 정적 라이브러리 만드는 데 그 네 배를 쓴다. MinGW `ar` + 윈도우
조합 문제로 보인다. 도구가 자기 자신의 샘플 프로젝트에서 뭘 하나 잡은 셈이다.

## 이 기기(윈도우)에서 걸리는 것들

**윈도우에서 configure하면 생성기가 Visual Studio다.** 그러면 CMake가 모든 타겟에
`ZERO_CHECK`를 의존으로 박는다. `test/run.js`의 링크 그래프 검사는 이제 트리뷰와
같은 기준으로 UTILITY를 걸러내고 비교한다(`linkNamesOf`). 생성기가 만든 타겟을
기대값에 넣어 맞추지 않는다 — 그러면 리눅스에서 깨진다.

**같은 이유로 윈도우 VS 트리에서는 Build Time 뷰가 빈다.** `.ninja_log`는 Ninja
제너레이터만 쓴다. VS 트리에는 대응물이 아예 없어서 고칠 수 있는 종류가 아니다.
보려면 `-G Ninja`로 트리를 하나 더 뽑거나, 리눅스 제품 빌드의 `.ninja_log`를 가져와
**Open Build Log로 열면 된다 — 조인은 크로스 OS로 동작한다**(테스트에 있다).

**`test/time-test.js`도 생성기에 걸린다.** 타겟 개수를 세는 단언이 있어서, VS
생성기로 bootstrap한 트리에서는 `ZERO_CHECK`/`ALL_BUILD` 때문에 숫자가 어긋난다.
`run.js`가 `linkNamesOf`로 푼 것과 같은 문제이므로 같은 방식으로 고쳤다 — 총계를
세지 말고 UTILITY를 걸러낸 뒤 비교한다.

**새 기기에서 클론하면 테스트가 크래시한다.** `test/fixture/`와
`test/sample-project/build/`는 `.gitignore` 대상이라 따라오지 않고, 없으면
`node test/run.js`와 `tree-test.js`가 죽는다. 익스텐션도 같은 이유로 빌드 트리를
못 찾아 "No CMake targets loaded yet."만 띄운다. `sh test/bootstrap.sh`, 또는
윈도우에서 `python test/make-fixture.py` + `cmake -S test/sample-project -B
test/sample-project/build`.

**VSIX에 `media/screenshots/README.md`가 들어간다.** 찍을 것을 적어둔 개발 메모인데
`.vscodeignore`가 `media/diagrams/**`만 빼고 있어서 사용자에게 배포된다. 스크린샷을
넣을 때 같이 정리한다.

## 게시

`Ruminem.cmake-link-explorer`. 버전 올리고 한 줄이면 된다.

```
npx.cmd @vscode/vsce publish        # PowerShell에서는 npx.cmd (실행 정책이 npx.ps1을 막는다)
```

Azure DevOps 조직 `ruminem` + PAT(Marketplace/Manage, All accessible organizations).
조직을 만들려면 Azure 구독 연결이 필수여서 종량제 구독을 붙였다 — 리소스를 만들지
않는 한 청구는 0원이다.

**PAT은 적어둔 만료일보다 먼저 죽는다.** 2027-09-05로 적어 뒀는데 2026-09-07에
`TF400813: ... is not authorized`로 거부당했다. 만료일을 믿지 말고, 거부당하면 그냥
재발급해서 `vsce login Ruminem`을 다시 돌린다. **PAT 입력이 대화형이라 이 한 단계는
사람이 직접 해야 한다.**

## 0.2.1에서 잡은 것 — 전부 "에러 없이 틀린 답"이었다

1. **File API 응답이 낡아도 아무 말이 없었다.** `target_link_libraries` 줄을 지워도
   "이미 링크돼 있음"이라고 답했다. 응답이 언제 쓰였는지와 그 응답을 만든
   CMakeLists들을 기록해 대조한다. 시각만 보면 `Ctrl+S`에도 걸리므로 **내용 해시**를
   같이 본다. 저장 안 된 버퍼도 센다(CMake는 버퍼가 아니라 파일을 읽는다).
2. **빌드 트리를 잘못 골랐다.** 워크스페이스에 트리가 둘이면 순회 순서로 집었고, 이
   저장소에서는 합성 픽스처가 이긴다. 픽스처가 sourceDir를 sample-project로 적어둬서
   **답이 진짜처럼 보였다.** 이제 가장 최근에 configure한 트리를 고른다.
3. **링크 편집이 조용히 틀렸다.** `if(WIN32)` 안의 호출에 붙거나, 계산해둔 scope를
   버리고 마지막 섹션(`INTERFACE`일 수도 있다)에 붙었다. 이제 둘 다 거절하고 별도
   호출을 만들며, 이유를 알림에 붙인다.
4. **컴파일 플래그의 `-D`가 빠졌다.** `CMAKE_CXX_FLAGS`나 `target_compile_options`로
   넣은 매크로는 코드모델의 `defines`가 아니라 `compileCommandFragments`에 들어간다.
   **NDEBUG나 _WIN32_WINNT를 플래그로 넣는 프로젝트면 정작 중요한 게 빠져 있었다.**
5. **상태 표시줄이 갱신되지 않았다.** `updateStatus()`가 `reload()`에서만 불려서,
   파일을 되돌려도 경고가 남고 방금 고친 파일엔 침묵했다.
6. **실행 파일이 링커 맵과 조인되지 않았다.** `.dir` 표식이 오브젝트 열이 아니라
   아카이브 열에 역슬래시로 들어 있었다. 귀속 63% → 87.4%.

**성능** — 상태 표시줄이 개수 하나 때문에 전체 정렬을 돌리고 있었다(2,000 타겟에서
5.4ms → 0.03ms). 신선도 해시는 `mtime + 크기`로 캐시한다(400 파일 전부 최신일 때
28ms → 5.2ms). 둘 다 타이핑 중 300ms마다 도는 경로였다.

**문서** — README의 mermaid 펜스를 PNG로 바꿨다. **마켓플레이스는 mermaid를 안 그려서**
상점 페이지에 소스가 회색 덩어리로 나왔다. 원본은 `media/diagrams/*.mmd`,
`sh media/diagrams/render.sh`로 다시 그린다. 주의할 점은 CLAUDE.md에 적어 뒀다
(`htmlLabels: false` 필수, SVG 금지).

## 다음 할 것

**상점 페이지에 실사용 스크린샷 넣기.** 지금 Overview에는 다이어그램만 있고 "이게
실제로 어떻게 보이는지"가 없다. 확장을 설치할지 말지는 대부분 그 사진으로 정해진다.
`media/screenshots/`에 넣고 README 두 판에서 절대 URL로 참조하면 된다(다이어그램과
같은 방식). Build Time 뷰가 생겼으니 찍을 게 둘 늘었다.

그다음 **0.3.0 게시.** PAT이 또 죽어 있을 테니 재발급부터 해야 할 가능성이 높다.

그 뒤: clang `-ftime-trace`(헤더 단위 파싱 시간), 그리고 여전히 **실제 회사
프로젝트.** spdlog는 타겟 5개라 순환도 미사용도 나올 게 없었다. 수백 개 규모에서
트리 정렬과 순환 탐지가 쓸 만한지가 다음 값어치다.

**찍을 것 (스크린샷)**

- Targets 트리 — 양방향 링크가 펼쳐진 상태. 실제 프로젝트가 좋다.
- Linker Map 뷰 — 크기가 붙은 타겟 목록. `C:/dev/_oss/spdlog/build-map/example/spdlog-example.map`이 1.47MB짜리 진짜 GNU ld 맵이다.
- **Build Time 뷰 — by target이 펼쳐진 상태.** 맵과 나란히 두면 크기/시간 대칭이 보인다.
- **Targets 행에 개수·크기·시간이 다 붙은 순간.** 맵과 로그를 둘 다 열어야 나온다.
- `#include` 줄의 퀵픽스 전구가 뜬 순간.
- What Is This File Compiled With? 출력.
- stale 경고가 뜬 순간.

경로에 사용자 이름이 보이지 않게 찍을 것.

**보류** — MSVC / lld 맵 포맷은 실물 샘플이 생기면. ninja 로그는 v5·v6가 열 구성이
같아서 받되 **v7만 실물로 검증했고**, v8 이상은 파싱은 하되 `unverifiedVersion`
플래그를 세운다(거절하지 않는다). 퍼블리셔 인증은 도메인이 있어야 하므로 안 한다.

**막힌 것** — 없음. 단위 5개 파일 + 확장 호스트 47개 전부 통과.
