# CMake Link Explorer

CMake 타겟의 **링크 구조를 양방향으로** 보여주는 VS Code 익스텐션.

CMakeLists.txt를 읽어서는 알 수 없는 두 가지를 보는 게 목적이다.

1. **누가 이 타겟을 링크하고 있나** (역방향)
2. **덩어리에서 실제 구조만 남긴 그래프** — 아래 "전이 축약" 참고

```
TARGETS
├── navi_app                exe
│   ├── links →             3
│   │   ├── dlt_wrapper     static
│   │   ├── map_engine      static
│   │   └── ui_core         shared
│   └── external            3
│       ├── -lsqlite3
│       ├── -ldlt
│       └── -lpthread
└── geo_utils               static
    └── linked by ←         2
        ├── map_engine      static
        └── ui_core         shared
```

## 어떻게 동작하나

CMakeLists.txt를 파싱하지 않는다. CMake의 **File API**(3.14+)를 쓴다.

빌드 디렉토리에 쿼리 파일을 하나 만들어 두면, CMake가 다음 configure 때
`.cmake/api/v1/reply/`에 **완전히 해석된 타겟 그래프를 JSON으로** 써준다.
익스텐션은 그 JSON만 읽는다. 제너레이터 표현식이나 조건부 링크를 직접
해석할 필요가 없다 — 이미 CMake가 계산한 결과다.

### 전이 축약 (transitive reduction)

File API의 `dependencies`는 **빌드 순서 기준 전이적 폐포**다. 실행 파일 하나가
결국 링크하게 되는 모든 라이브러리를 나열하기 때문에, 그대로 보여주면
`target_link_libraries`에 세 줄 적은 타겟이 50개를 링크하는 것처럼 보인다.

그래서 도달성을 보존하는 **최소 간선 집합**으로 줄여서 보여준다.
실측 (abseil-cpp, 타겟 121개):

| | |
|---|---|
| CMake가 보고한 간선 | 1,405개 |
| 축약 후 | 134개 (**90% 감소**) |
| `log_flags` 타겟 | 50개 → 3개 |

**주의 —** 축약된 그래프는 "링크 구조의 최소 형태"지 "`target_link_libraries`에
적힌 목록"이 아니다. 둘은 단순한 프로젝트에서는 일치하지만 항상 그렇지는 않다.

- A가 B와 C를 명시적으로 링크하는데 B도 C를 링크하면, `A → C` 간선은 숨는다
- 헤더 전용 INTERFACE 라이브러리는 CMake 코드모델에 타겟으로 나오지 않으므로
  애초에 표시되지 않는다 (abseil 같은 프로젝트에서 흔하다)

전체를 보려면 `cmakeLinkExplorer.showTransitiveDependencies`를 켜면 된다.
툴팁에는 항상 `links: 3 (50 including transitive)` 형태로 양쪽 개수가 함께 나온다.

## 설치

빌드 단계가 없다. 의존성도 없다.

1. 이 폴더를 VS Code로 연다
2. `F5` — 익스텐션이 켜진 새 창(Extension Development Host)이 뜬다
3. 새 창에서 C++ 프로젝트를 연다
4. 활동 표시줄의 **CMake Links** 아이콘

빌드 디렉토리는 워크스페이스에서 `CMakeCache.txt`를 찾아 자동 탐지한다
(3단계 깊이까지). 못 찾거나 여러 개면 **Select build directory**로 지정.

File API 리플라이가 아직 없으면 configure를 한 번 돌리라고 안내한다.
버튼을 누르면 터미널에서 `cmake <build-dir>`를 실행한다.

상시 사용하려면 심볼릭 링크를 걸면 된다:

```
ln -s "$(pwd)" ~/.vscode/extensions/cmake-link-explorer
```

## 기능

| | |
|---|---|
| `links →` | 이 타겟이 링크하는 것 (축약된 최소 집합) |
| `linked by ←` | **이 타겟을 링크하는 것** |
| `external` | 프로젝트 밖에서 오는 라이브러리 (시스템 라이브러리, 프레임워크) |

- 노드를 계속 펼치면 그 방향으로 체인을 따라간다
- 타겟 클릭 → 그 타겟을 정의한 `CMakeLists.txt`의 `add_library`/`add_executable` 줄로 점프
- **Find Target** — 이름으로 찾아 트리에서 선택
- **Why Is This Linked?** — 두 타겟을 고르면 최단 의존 경로를 한 홉씩 추적한다.
  "왜 navi_app이 sqlite_wrap을 끌고 오지?"에 답하는 기능
- CMake가 재구성되면 리플라이 파일을 감시해 자동 갱신

## 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `cmakeLinkExplorer.buildDirectory` | `""` | 빌드 디렉토리. 비우면 자동 탐지 |
| `cmakeLinkExplorer.configuration` | `""` | 멀티 컨피그 제너레이터에서 볼 구성 (Debug/Release) |
| `cmakeLinkExplorer.showUtilityTargets` | `false` | UTILITY 타겟 표시 (ALL_BUILD, ZERO_CHECK 등) |
| `cmakeLinkExplorer.showExternalLibraries` | `true` | 외부 라이브러리 표시 |
| `cmakeLinkExplorer.showTransitiveDependencies` | `false` | 축약하지 않고 전체 폐포 표시 |

## 테스트

CMake 없이 (합성 픽스처):

```
python3 test/make-fixture.py
node test/run.js
node test/tree-test.js
```

실제 CMake 빌드 트리로 — 아무 프로젝트나 된다:

```
cmake -S test/sample-project -B /tmp/navi-build
mkdir -p /tmp/navi-build/.cmake/api/v1/query/client-cmake-link-explorer
touch /tmp/navi-build/.cmake/api/v1/query/client-cmake-link-explorer/codemodel-v2
cmake /tmp/navi-build
node test/run.js /tmp/navi-build
```

실제 VS Code 확장 호스트 안에서 (활성화, 명령 등록, 트리, 에디터 점프까지):

```
CMAKE_LINK_TEST_LOG=/tmp/it.log \
"/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/integration" \
  --disable-extensions "$PWD/test/sample-project"
cat /tmp/it.log
```

확장 호스트는 stdout으로 로그를 넘기지 않으므로 `CMAKE_LINK_TEST_LOG`로 받는다.

### 검증 현황

| 대상 | 결과 |
|---|---|
| 합성 픽스처 | 15 checks |
| `test/sample-project` (실제 CMake 4.4) | 17 checks |
| googletest (타겟 4개) | 8 generic checks |
| abseil-cpp (타겟 121개) | 8 generic checks, 로딩 10ms |
| VS Code 확장 호스트 (1.136) | 19 checks |
| 트리 렌더링 | 12 checks |

## 앞으로

- 그래프 뷰 (웹뷰 + 노드 드래그)
- 링커 맵 파일 탭 — 심볼별 크기, 빌드 간 diff
- 순환 의존 / 미사용 타겟 표시
