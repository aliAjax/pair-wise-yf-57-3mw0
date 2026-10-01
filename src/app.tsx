import { Provider } from 'react-redux';
import '@nutui/nutui-react-taro/dist/style.css';
import './app.scss';
import { store } from './store';
import { I18nProvider } from './i18n';

export default function App({ children }: { children?: React.ReactNode }) {
  return <I18nProvider><Provider store={store}>{children}</Provider></I18nProvider>;
}
