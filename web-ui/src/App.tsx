import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout/Layout'
import { SearchPage } from './pages/SearchPage'
import { UploadPage } from './pages/UploadPage'
import { FilesPage } from './pages/FilesPage'
import { StatusPage } from './pages/StatusPage'

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </Layout>
  )
}

export default App
