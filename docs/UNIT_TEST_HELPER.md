# Unit Test Helper

## Run single test file with coverage
```
npm run test -- src/__tests__/integrations-langchain.test.ts --coverage --collectCoverageFrom="src/integrations/langchain-callback.ts"
```

## Run single test file without coverage
```
npm run test -- src/__tests__/integrations-auto-langchain.test.ts 
```

## Run all test files without coverage
```
npm run test
```

## Run all test files with coverage
```
npm run test -- --coverage
```


## Test Coverage Summary
```
npm run test:cov
```
