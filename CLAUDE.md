# CMake Link Explorer

CMake 프로젝트의 링크 관계를 보여주는 VS Code 익스텐션. 순수 JavaScript.

**빌드 없음. 의존성 없음. `npm install` 필요 없음.** `package.json`에 `scripts`도
`devDependencies`도 없다. 클론해서 `~/.vscode/extensions`에 링크 걸면 끝이다.
이 성질을 깨는 변경(번들러 도입, 런타임 의존성 추가)은 하지 않는다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/extension.js` | 진입점. 명령 등록, 뷰 배선, 활성화 |
| `src/fileApi.js` | CMake File API 읽기 → 타겟 모델 |
| `src/tree.js` | Targets 트리뷰 |
| `src/mapFile.js` | 링커 맵 파서 (GNU ld / ld64) |
| `src/mapTree.js` | Linker Map 트리뷰 + diff |
| `src/includeResolver.js` | `#include` → 링크할 타겟 판정 |
| `src/cmakeEdit.js` | CMakeLists.txt 최소 편집 (append만) |

## 테스트

`node`만 있으면 된다. `test/maps/`에 진짜 링커가 만든 맵이 커밋돼 있어서
툴체인 없이도 파서 테스트가 돈다.

```
node test/run.js            # File API 픽스처
node test/tree-test.js      # 타겟 트리
node test/map-test.js       # 맵 파서 + 맵 트리
node test/include-test.js   # include 해결 + CMakeLists 편집
```

`test/bootstrap.sh`(생성물 만들기)와 실제 CMake 빌드 검증은 `cmake`가 필요하다.
없으면 위 4개만 돌려도 대부분 검증된다.

확장 호스트 통합 테스트는 플랫폼마다 VS Code 실행 경로가 다르다. README의
"테스트" 절 참고.

## 플랫폼 주의 (맥/윈도우 양쪽에서 작업함)

- **README의 명령은 macOS 기준으로 쓰여 있다.** `ln -s`, `/Applications/...`,
  `/tmp/...`는 윈도우에서 안 통한다. 윈도우는 `mklink /J`와 `%USERPROFILE%` 경로.
- **경로 비교는 반드시 대소문자 무관 처리를 거친다.** 윈도우와 기본 macOS 볼륨은
  대소문자를 구분하지 않고, VS Code가 CMake 기록과 다른 대소문자(드라이브 문자
  포함)를 돌려줄 수 있다. 그냥 비교하면 파일→타겟 매핑이 통째로 실패한다.
  이미 한 번 고친 버그이므로 되돌리지 않는다.
- 경로를 새로 다루는 코드를 쓸 때는 구분자(`\` vs `/`)를 직접 가정하지 말고
  `path` 모듈을 쓴다.

## 관례

- 커밋 메시지는 **무엇을 왜 바꿨는지 서술하는 영어 문장**. 접두사(`feat:`) 안 쓴다.
- 커밋에 `Co-Authored-By` 트레일러를 붙이지 않는다.
- 세션을 끝낼 때 `NEXT.md`를 갱신한다 (여기까지 됨 / 다음 할 것 / 막힌 것).
  기기를 옮겨가며 작업하므로 이 파일이 유일한 인수인계 수단이다.
- 취미 프로젝트다. 주말 단위로 굴러가는 범위를 넘기지 않는다.
