# NEXT

**막힌 것 — 0.2.2 게시가 PAT 때문에 멈춰 있다.** 커밋까지는 다 됐고
`vsce publish`가 `TF400813: The user ... is not authorized`로 거부했다. 만료일을
2027-09-05로 적어 뒀지만 토큰이 죽어 있다. **재발급 후 `vsce login Ruminem`을
직접 돌려야 한다** (PAT 입력이 대화형이라 다른 방법이 없다). 그 다음
`npx.cmd @vscode/vsce publish` 한 줄이면 끝나고, 성공하면 `v0.2.2` 태그를 붙인다.
커밋 `d3a13f1`(Release 0.2.2)까지는 origin/main에 올라가 있다.

**0.2.2에 들어간 것** — 0.2.1 이후의 인터페이스 수정 둘. 상태 표시줄이 돌지도 않은
빌드 트리 탐색 결과를 말하던 것, 그리고 저장에 실패한 링크 편집이 "저장됨"이라고
답하던 것.

**여기까지 됨** — 0.2.1을 **VS Code 마켓플레이스에 올렸다.** 그리고 실제로 써 보면서
조용히 틀리던 것들을 여섯 개 잡았다.

**게시** — `Ruminem.cmake-link-explorer`. 다음부터는 버전 올리고 한 줄이면 된다.

```
npx.cmd @vscode/vsce publish        # PowerShell에서는 npx.cmd (실행 정책이 npx.ps1을 막는다)
```

Azure DevOps 조직 `ruminem` + PAT(Marketplace/Manage, All accessible organizations,
2027-09-05 만료)로 로그인해 뒀다. **토큰이 만료되면 재발급 후 `vsce login Ruminem`.**
조직을 만들려면 Azure 구독 연결이 필수여서 종량제 구독을 붙였다 — 리소스를 만들지
않는 한 청구는 0원이다.

**새 기기에서 클론하면 테스트가 크래시한다.** `test/fixture/`와
`test/sample-project/build/`는 `.gitignore` 대상이라 따라오지 않고, 없으면
`node test/run.js`와 `tree-test.js`가 죽는다. 익스텐션도 같은 이유로 빌드 트리를
못 찾아 "No CMake targets loaded yet."만 띄운다. `sh test/bootstrap.sh`, 또는
윈도우에서 `python test/make-fixture.py` + `cmake -S test/sample-project -B
test/sample-project/build`.

**윈도우에서 configure하면 생성기가 Visual Studio다.** 그러면 CMake가 모든 타겟에
`ZERO_CHECK`를 의존으로 박는다. `test/run.js`의 링크 그래프 검사는 이제 트리뷰와
같은 기준으로 UTILITY를 걸러내고 비교한다(`linkNamesOf`). 생성기가 만든 타겟을
기대값에 넣어 맞추지 않는다 — 그러면 리눅스에서 깨진다.

**VSIX에 `media/screenshots/README.md`가 들어간다.** 찍을 것을 적어둔 개발 메모인데
`.vscodeignore`가 `media/diagrams/**`만 빼고 있어서 사용자에게 배포된다. 스크린샷을
넣을 때 같이 정리한다.

**이번에 잡은 것 — 전부 "에러 없이 틀린 답"이었다**

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

**다음 할 것** — **상점 페이지에 실사용 스크린샷 넣기.** 지금 Overview에는 다이어그램만
있고 "이게 실제로 어떻게 보이는지"가 없다. 확장을 설치할지 말지는 대부분 그 사진으로
정해진다. `media/screenshots/`에 넣고 README 두 판에서 절대 URL로 참조하면 된다
(다이어그램과 같은 방식). 무엇을 찍을지는 아래 "찍을 것" 참고.

그 다음은 여전히 **실제 회사 프로젝트.** spdlog는 타겟 5개라 순환도 미사용도 나올 게
없었다. 수백 개 규모에서 트리 정렬과 순환 탐지가 쓸 만한지가 다음 값어치다.

**찍을 것 (스크린샷)**

- Targets 트리 — 양방향 링크가 펼쳐진 상태. 실제 프로젝트가 좋다.
- Linker Map 뷰 — 크기가 붙은 타겟 목록. `C:/dev/_oss/spdlog/build-map/example/spdlog-example.map`이 1.47MB짜리 진짜 GNU ld 맵이다.
- `#include` 줄의 퀵픽스 전구가 뜬 순간.
- What Is This File Compiled With? 출력.
- stale 경고가 뜬 순간 (오늘 넣은 기능이라 이게 제일 새롭다).

경로에 사용자 이름이 보이지 않게 찍을 것.

**보류** — MSVC / lld 맵 포맷은 실물 샘플이 생기면. 퍼블리셔 인증(파란 체크)은 도메인이
있어야 하므로 안 한다.

**막힌 것** — 없음. 단위 199 + 확장 호스트 40 + 리눅스 워크플로 전부 통과.
