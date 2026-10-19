/** Module boundary rules (brief §5). Violations fail CI via `npm run lint`. */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment:
        'A module may only import another module through its public index.ts, never its internals or tables.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\.ts$'],
      },
    },
    {
      name: 'outside-uses-module-index-only',
      comment:
        'Code outside src/modules (routes, worker, scripts) imports modules via index.ts only. src/db may import schema.ts to assemble the drizzle schema.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(modules/|db/)' },
      to: { path: '^src/modules/[^/]+/', pathNot: '^src/modules/[^/]+/index\.ts$' },
    },
    {
      name: 'db-may-only-import-schemas',
      severity: 'error',
      from: { path: '^src/db/' },
      to: { path: '^src/modules/[^/]+/', pathNot: '^src/modules/[^/]+/(schema|index)\.ts$' },
    },
    {
      name: 'domain-is-pure',
      comment: 'Domain logic is plain TypeScript: no Next.js, DB, React or provider imports.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: '^(node_modules/)?(next|react|react-dom|drizzle-orm|pg|pg-boss|razorpay|better-auth|nodemailer|@aws-sdk)(/|$)',
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-peer',
          'npm-optional',
          'npm-no-pkg',
          'npm-unknown',
        ],
      },
    },
    {
      name: 'domain-does-not-import-infrastructure',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: { path: '^src/(db|lib|app|worker)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
