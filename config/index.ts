import { defineConfig } from '@tarojs/cli';

export default defineConfig({
  projectName: 'pair-wise-yf-57',
  date: '2026-09-29',
  designWidth: 375,
  deviceRatio: { 375: 2, 750: 1 },
  sourceRoot: 'src',
  outputRoot: 'dist',
  framework: 'react',
  compiler: 'webpack5',
  cache: { enable: false },
  plugins: ['@tarojs/plugin-platform-h5'],
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    devServer: { host: '0.0.0.0', port: 62022 },
    miniCssExtractPluginOption: { ignoreOrder: true }
  },
  mini: {}
});
