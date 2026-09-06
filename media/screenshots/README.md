# 스크린샷

상점 페이지(Overview 탭)는 README를 그대로 렌더링한다. **마켓플레이스에 별도의 스크린샷
갤러리가 없으므로 사진도 README에 들어간다.** 다이어그램과 같은 방식이다 — 여기 PNG를
넣고 README 두 판에서 절대 URL로 참조한다.

```
https://raw.githubusercontent.com/Ruminem/cmake-link-explorer/main/media/screenshots/<이름>.png
```

## 규칙

- **PNG만.** `vsce`가 README에 SVG가 참조되면 패키징을 거부한다.
- **경로에 사용자 이름이 보이지 않게 찍는다.** `C:\dev\...` 아래에서 열면 된다.
- 폭은 1600px 안팎이면 충분하다. 상점 페이지가 본문 폭(약 840px)으로 줄여서 보여준다.
- 패널만 바짝 잘라낸다. 창 전체를 찍으면 정작 보여줄 것이 작아진다.
- 편집기 글자 크기를 두어 단계 키우고 찍는다(`Ctrl` + `=`). 축소돼 표시되므로
  평소 크기로 찍으면 읽히지 않는다.

## 찍을 것

| 파일 이름 | 무엇을 |
|---|---|
| `targets.png` | Targets 트리. 양방향 링크가 펼쳐진 상태 |
| `map.png` | Linker Map 뷰. 타겟마다 크기가 붙은 화면 |
| `quickfix.png` | `#include` 줄에 퀵픽스 전구가 뜬 순간 |
| `compile-settings.png` | What Is This File Compiled With? 출력 |
| `stale.png` | "changed since CMake last configured" 경고가 뜬 순간 |

맵 화면에 쓸 진짜 링커 맵이 하나 있다:
`C:/dev/_oss/spdlog/build-map/example/spdlog-example.map` (1.47MB, GNU ld).
