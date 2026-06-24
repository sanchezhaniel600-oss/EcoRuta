// ============================================================================
// ECORUTA - CONFIGURACIÓN FIREBASE Y VALIDACIONES
// ============================================================================
// Este archivo:
// 1. Inicializa Firebase Authentication y Firestore Database
// 2. Valida campos de formularios en tiempo real (email, contraseña, nombre, etc)
// 3. Maneja el modal de términos y condiciones
// 4. Actualiza la visualización del perfil del usuario autenticado
// ============================================================================

// Importar módulos de Firebase necesarios para autenticación y base de datos
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { getFirestore, doc, setDoc, deleteDoc, serverTimestamp, collection, addDoc, onSnapshot, query, orderBy, getDocs, updateDoc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

// CONFIGURACIÓN DE FIREBASE
// Proyecto: ecoruta-aaca0
// Contiene credenciales para conectar a los servicios de Firebase
const firebaseConfig = {
  apiKey: "AIzaSyAmk5MVZZni9_WXut3uQDXyeMzg_mUhr9Y",
  authDomain: "ecoruta-aaca0.firebaseapp.com",
  projectId: "ecoruta-aaca0",
  storageBucket: "ecoruta-aaca0.firebasestorage.app",
  messagingSenderId: "18232074806",
  appId: "1:18232074806:web:4a19c2197f1e4d52f3ee97"
};

// Inicializar aplicación Firebase
const app = initializeApp(firebaseConfig);

// Obtener referencias a los servicios de Firebase
const auth = getAuth(app);      // Para manejar autenticación de usuarios
const db = getFirestore(app);   // Para acceder a la base de datos Firestore

// Exportar objetos de Firebase al objeto global window
// Esto permite que otros scripts puedan acceder a la autenticación y la BD
window.firebaseAuth = auth;
window.firebaseDb = db;

// Exportar funciones de autenticación para login/registro
window.firebaseAuthApi = {
  signInWithEmailAndPassword,     // Login con email y contraseña
  createUserWithEmailAndPassword, // Registro de nuevo usuario
  signOut,                        // Cerrar sesión
  onAuthStateChanged             // Monitorear cambios de autenticación
};

// Exportar funciones de Firestore para guardar datos de usuario
window.firebaseFirestoreApi = {
  // Document / write helpers
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  // Collections / queries
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  getDocs,
  // Field helpers
  arrayUnion,
  // Timestamps
  serverTimestamp
};

// ==================== HELPERS RESILIENTES PARA FIRESTORE ====================
// Pequeños utilitarios para mantener listeners/polling hasta que el usuario
// cierre la página. Usar con cautela para evitar consumo innecesario.

/**
 * Wrapper ligero para `onSnapshot` que re-intenta en errores no fatales.
 * Retorna la función `unsubscribe` tal como `onSnapshot`.
 */
function reliableOnSnapshot(refOrQuery, onNext, onError) {
  if (!onSnapshot) {
    const err = new Error('onSnapshot no disponible');
    onError && onError(err);
    return () => {};
  }

  let unsubscribe = null;
  let retryDelay = 1000; // 1s

  function attach() {
    try {
      unsubscribe = onSnapshot(refOrQuery, snapshot => {
        retryDelay = 1000; // reset backoff on success
        onNext && onNext(snapshot);
      }, err => {
        console.warn('onSnapshot error, reintentando:', err);
        onError && onError(err);
        // detach current and schedule reattach with backoff
        if (unsubscribe) try { unsubscribe(); } catch(_){}
        setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 60000);
          attach();
        }, retryDelay);
      });
    } catch (e) {
      console.warn('Fallo al adjuntar onSnapshot, reintentando', e);
      setTimeout(attach, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
  }

  attach();

  return () => {
    try { if (unsubscribe) unsubscribe(); } catch(e){}
    unsubscribe = null;
  };
}

/**
 * Inicia un polling resiliente usando `getDocs` repetidamente.
 * - `getQuery` es una función que retorna la query/ref actual (para evitar staleness)
 * - `onData` recibe el resultado de `getDocs`
 * Retorna una función `stop()` para cancelar el polling.
 */
function startPollingGetDocs(getQuery, onData, opts = {}) {
  const interval = opts.interval || 5000;
  let stopped = false;

  (async function loop() {
    let backoff = interval;
    while (!stopped) {
      try {
        const q = getQuery();
        if (!q) throw new Error('Query nula en startPollingGetDocs');
        const snapshot = await getDocs(q);
        onData && onData(snapshot);
        backoff = interval; // reset
        await new Promise(r => setTimeout(r, interval));
      } catch (err) {
        console.warn('Polling getDocs falló, reintentando en', backoff, 'ms', err);
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  })();

  return () => { stopped = true; };
}

// Exponer helpers en el objeto global para que otros scripts los usen
window.firebaseResilient = {
  reliableOnSnapshot,
  startPollingGetDocs
};

// Al descargar la página, detener cualquier polling o listener iniciado
window.addEventListener('beforeunload', () => {
  try { if (window._ecoruta_news_poll_stop) window._ecoruta_news_poll_stop(); } catch(_){}
  try { if (window._ecoruta_community_unsub) window._ecoruta_community_unsub(); } catch(_){}
  try { if (window._ecoruta_routes_unsub) window._ecoruta_routes_unsub(); } catch(_){}
  try { if (window._ecoruta_routes_poll_stop) window._ecoruta_routes_poll_stop(); } catch(_){}
  try { if (window._ecoruta_users_poll_stop) window._ecoruta_users_poll_stop(); } catch(_){}
});

// ============================================================================
// MÓDULO DE VALIDACIONES Y ENHANCEMENTS
// ============================================================================
// Ejecuta como IIFE (Immediately Invoked Function Expression) para evitar
// contaminación del scope global y mantener variables privadas
(function(){
  'use strict';
  
  // FUNCIONES AUXILIARES DEL DOM
  // Atajos para querySelector (un elemento) y querySelectorAll (múltiples)
  function qs(sel, root=document){return root.querySelector(sel)}
  function qsa(sel, root=document){return Array.from(root.querySelectorAll(sel))}

  // ==================== FUNCIONES DE VALIDACIÓN EN TIEMPO REAL ====================
  
  /**
   * Asegura que existe un elemento de mensaje para el campo de entrada
   * Si no existe, lo crea y lo agrega al DOM
   */
  function ensureMessageEl(input){
    let el = input.parentElement.querySelector('.ecoruta-field-message');
    if(!el){ 
      el = document.createElement('div'); 
      el.className='ecoruta-field-message'; 
      input.parentElement.appendChild(el); 
    }
    return el;
  }

  /**
   * Marcar campo como INVÁLIDO
   * Agrega estilos rojos y muestra mensaje de error
   */
  function setInvalid(input,msg){ 
    input.classList.remove('ecoruta-input-valid'); 
    input.classList.add('ecoruta-input-invalid'); 
    const el=ensureMessageEl(input); 
    el.textContent=msg; 
    el.className='ecoruta-field-message ecoruta-field-error'; 
  }
  
  /**
   * Marcar campo como VÁLIDO
   * Agrega estilos verdes y muestra mensaje de éxito (opcional)
   */
  function setValid(input,msg){ 
    input.classList.remove('ecoruta-input-invalid'); 
    input.classList.add('ecoruta-input-valid'); 
    const el=ensureMessageEl(input); 
    el.textContent=msg||''; 
    el.className='ecoruta-field-message ecoruta-field-success'; 
  }

  /**
   * VALIDAR EMAIL
   * Verifica: no vacío, formato válido (usuario@dominio.com)
   * Retorna mensaje de error o cadena vacía si es válido
   */
  function validateEmail(value){ 
    if(!value) return 'Email vacío'; 
    // Regex: caracteres@caracteres.dominio
    const re=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i; 
    if(!re.test(value)) return 'Formato de email inválido'; 
    return '' 
  }
  
  /**
   * VALIDAR NOMBRE DE USUARIO
   * Verifica:
   * - No vacío
   * - 3-40 caracteres
   * - Solo letras, números, espacios, guiones, guiones bajos, puntos
   * - No más de 4 caracteres repetidos (aaaa)
   */
  function validateUsername(value){ 
    if(!value) return 'Nombre vacío'; 
    if(value.length<3) return 'Mínimo 3 caracteres'; 
    if(value.length>40) return 'Nombre demasiado largo'; 
    if(/[^\p{L}0-9 \-_.]/u.test(value)) return 'Caracteres no permitidos'; 
    if(/(.)\1{4,}/.test(value)) return 'Nombre inválido'; 
    return '' 
  }

  /**
   * CALCULAR FORTALEZA DE CONTRASEÑA
   * Retorna puntuación 0-5:
   * - 6+ caracteres (1 punto)
   * - Mayúsculas (1 punto)
   * - Minúsculas (1 punto)
   * - Números (1 punto)
   * - Símbolos especiales (1 punto)
   */
  function passwordStrength(value){ 
    let score=0; 
    if(value.length>=6) score++;           // Largo suficiente
    if(/[A-Z]/.test(value)) score++;       // Tiene mayúsculas
    if(/[a-z]/.test(value)) score++;       // Tiene minúsculas
    if(/[0-9]/.test(value)) score++;       // Tiene números
    if(/[^A-Za-z0-9]/.test(value)) score++; // Tiene símbolos
    return score 
  }

  /**
   * VALIDAR CONTRASEÑA
   * Verifica:
   * - No vacía
   * - No solo espacios
   * - Mínimo 6 caracteres
   */
  function validatePassword(value){ 
    if(!value) return 'Contraseña vacía'; 
    if(value.trim().length===0) return 'Contraseña no puede ser solo espacios'; 
    if(value.length<6) return 'La contraseña es demasiado corta'; 
    return '' 
  }

  /**
   * ADJUNTAR VALIDACIÓN EN TIEMPO REAL A UN FORMULARIO
   * 
   * Para cada input/textarea:
   * 1. Valida en tiempo real mientras el usuario escribe (evento 'input')
   * 2. Muestra barras de fortaleza para contraseñas
   * 3. Valida al perder foco (evento 'blur')
   * 4. Bloquea envío si hay errores de validación
   */
  function attachValidationToForm(form){
    // Evitar adjuntar validación dos veces al mismo formulario
    if(form.dataset.ecAttached) return;
    
    // Procesar cada campo de entrada o textarea
    qsa('input,textarea',form).forEach(input=>{
      if(input.dataset.ecAttached) return;
      
      const name=input.name||input.id||'';
      input.dataset.ecAttached = '1';

      // EVENTO: Validar mientras el usuario escribe (en tiempo real)
      input.addEventListener('input',()=>{
        const val=input.value;
        
        // CASO 1: Checkbox - validar si está marcado
        if(input.type && input.type.toLowerCase()==='checkbox'){
          const ok = !input.required || input.checked;
          input.classList.toggle('ecoruta-input-valid', ok);
          input.classList.toggle('ecoruta-input-invalid', !ok);
        } 
        // CASO 2: Campo de email
        else if(name.toLowerCase().includes('email')){
          const e=validateEmail(val);
          if(e) setInvalid(input,e); else setValid(input,'Email OK');
        } 
        // CASO 3: Campo de nombre/usuario
        else if(name.toLowerCase().includes('user')||name.toLowerCase().includes('nombre')){
          const e=validateUsername(val); 
          if(e) setInvalid(input,e); else setValid(input,'Nombre válido');
        } 
        // CASO 4: Campo de contraseña
        else if(name.toLowerCase().includes('pass')){
          const e=validatePassword(val); 
          if(e) setInvalid(input,e); else setValid(input,'');
          
          // Crear o actualizar barra de fortaleza visual
          let bar=input.parentElement.querySelector('.ecoruta-strength'); 
          if(!bar){ 
            bar=document.createElement('div'); 
            bar.className='ecoruta-strength'; 
            bar.innerHTML='<i></i>'; 
            input.parentElement.appendChild(bar); 
          }
          
          // Calcular y mostrar fortaleza (0-100%)
          const score=passwordStrength(val); 
          const pct=Math.min(100,score*20);
          bar.firstElementChild.style.width=pct+'%';
          
          // Mostrar texto de fortaleza (débil/media/fuerte)
          const msgEl = ensureMessageEl(input);
          if(score<=2) msgEl.textContent = 'Contraseña débil'; 
          else if(score===3) msgEl.textContent = 'Contraseña media'; 
          else msgEl.textContent = 'Contraseña fuerte';
        } 
        // CASO 5: Otros campos
        else {
          if(val.trim()==='') setInvalid(input,'Campo vacío'); else setValid(input,'');
        }
      });
      
      // EVENTO: Validar cuando el usuario deja el campo (blur)
      input.addEventListener('blur', ()=> input.dispatchEvent(new Event('input')));
    });
    
    // EVENTO: Validar cuando intenta enviar el formulario
    form.addEventListener('submit', (e)=>{
      // Ejecutar todas las validaciones nuevamente
      qsa('input,textarea', form).forEach(i => i.dispatchEvent(new Event('input')));
      
      // Contar errores
      const invalid = qsa('.ecoruta-input-invalid', form);
      
      // Si hay errores, prevenir envío y enfocar primer error
      if(invalid.length>0){ 
        e.preventDefault(); 
        invalid[0].focus(); 
        console.warn('Formulario bloqueado por validaciones'); 
      }
    });
    
    // Marcar formulario como procesado
    form.dataset.ecAttached = '1';
  }

  // ==================== INICIALIZACIÓN CUANDO EL DOM ESTÁ LISTO ====================
  document.addEventListener('DOMContentLoaded', ()=>{
    // RESTAURAR SESIÓN DESDE LOCALSTORAGE SI EXISTE
    if (typeof restoreSessionFromLocalStorage === 'function') {
      restoreSessionFromLocalStorage();
    }
    
    // Paso 1: Adjuntar validación a TODOS los formularios de la página
    qsa('form').forEach(form=> attachValidationToForm(form));

    // ==================== MANEJO DEL MODAL DE TÉRMINOS Y CONDICIONES ====================
    // Los usuarios deben aceptar los términos antes de registrarse
    
    const termsModal = qs('#terms-modal');                          // Modal que muestra los términos
    const termsCheckbox = qs('#register-terms');                    // Checkbox para aceptar
    const termsAcceptBtn = qs('#accept-terms-btn');                 // Botón "Aceptar términos"
    const registerForm = qs('#register-form');                      // Formulario de registro
    const termsError = qs('#register-terms-error');                 // Mensaje de error
    let termsAccepted = !!(termsCheckbox && termsCheckbox.checked); // Estado de aceptación

    /**
     * Abre el modal de términos y condiciones
     * Agrega clase CSS 'is-open' y enfoca el botón de aceptar
     */
    function openTermsModal(){
      if(!termsModal) return;
      termsModal.classList.add('is-open');
      termsModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('terms-modal-open');
      // Enfocar botón después de animación
      setTimeout(()=> termsAcceptBtn && termsAcceptBtn.focus(), 50);
    }

    /**
     * Cierra el modal de términos y condiciones
     * Remueve clase CSS 'is-open'
     */
    function closeTermsModal(){
      if(!termsModal) return;
      termsModal.classList.remove('is-open');
      termsModal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('terms-modal-open');
    }

    /**
     * Actualiza el estado de aceptación de términos
     * - Marca/desmarca checkbox
     * - Actualiza validación visual
     * - Muestra/oculta mensajes de error
     */
    function setTermsAccepted(accepted){
      if(!termsCheckbox) return;
      termsAccepted = accepted;
      termsCheckbox.checked = accepted;
      termsCheckbox.classList.toggle('ecoruta-input-valid', accepted);
      termsCheckbox.classList.toggle('ecoruta-input-invalid', !accepted);
      termsCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      termsCheckbox.dispatchEvent(new Event('input', { bubbles: true }));
      if(termsError) termsError.textContent = accepted ? '' : 'Debes aceptar los términos para continuar.';
    }

    // ADJUNTAR EVENTOS AL CHECKBOX DE TÉRMINOS
    if(termsCheckbox && termsModal && !termsCheckbox.dataset.termsModalAttached){
      
      // Evento: Hacer click en checkbox abre modal si no están aceptados
      termsCheckbox.addEventListener('click', (event)=>{
        if(termsAccepted){
          // Si ya fueron aceptados, permitir desmarcar
          if(!termsCheckbox.checked) setTermsAccepted(false);
          return;
        }
        // Si no están aceptados, mostrar modal
        event.preventDefault();
        openTermsModal();
      });

      // Evento: Botones para cerrar el modal sin aceptar
      qsa('[data-terms-close]', termsModal).forEach(btn=>{
        btn.addEventListener('click', ()=>{
          if(!termsAccepted) setTermsAccepted(false);
          closeTermsModal();
        });
      });

      // Evento: Botón "Aceptar términos"
      if(termsAcceptBtn){
        termsAcceptBtn.addEventListener('click', ()=>{
          setTermsAccepted(true);      // Marcar como aceptados
          closeTermsModal();           // Cerrar modal
          termsCheckbox.focus();       // Enfocar checkbox
        });
      }

      // Evento: Tecla ESC cierra el modal
      document.addEventListener('keydown', (event)=>{
        if(event.key === 'Escape' && termsModal.classList.contains('is-open')){
          if(!termsAccepted) setTermsAccepted(false);
          closeTermsModal();
          termsCheckbox.focus();
        }
      });

      // Evento: Validar términos al enviar formulario de registro
      if(registerForm){
        registerForm.addEventListener('submit', (event)=>{
          if(!termsCheckbox.checked){
            event.preventDefault();
            setTermsAccepted(false);
            openTermsModal();
          }
        }, true);
      }

      // Marcar como procesado
      termsCheckbox.dataset.termsModalAttached = '1';
    }

    // ==================== ACTUALIZAR MENÚ DE PERFIL DEL USUARIO ====================
    // Mostrar/ocultar información del perfil dependiendo si hay sesión activa
    
    const existingProfile = qs('#profile-menu-container');
    if(existingProfile && !existingProfile.dataset.ecEnhanced){
      
      /**
       * Actualiza la visibilidad del menú de perfil según el estado de sesión
       * Si hay usuario logueado:
       * - Mostrar menú de perfil
       * - Llenar nombre, email y avatar del usuario
       */
      function updateProfileVisibility(){
        try{
          const logged = !!(window.isLoggedIn);
          if(logged && window.currentUser){
            // Mostrar menú si hay sesión activa
            existingProfile.style.display = '';
            
            // Llenar datos del usuario en el menú
            const nameEl = existingProfile.querySelector('.profile-dropdown-info h4');
            const emailEl = existingProfile.querySelector('.profile-dropdown-info p');
            if(nameEl && window.currentUser.name) nameEl.textContent = window.currentUser.name;
            if(emailEl && window.currentUser.email) emailEl.textContent = window.currentUser.email;
            
            // Mostrar avatar del usuario
            const avatarEl = existingProfile.querySelector('.profile-menu-btn .default-avatar');
            if(avatarEl && window.currentUser.avatarUrl) avatarEl.style.backgroundImage = `url(${window.currentUser.avatarUrl})`;
          } else {
            // Ocultar menú si no hay sesión
            existingProfile.style.display = 'none';
          }
        }catch(e){ /* ignorar errores silenciosamente */ }
      }
      
      // Actualizar perfil inmediatamente
      updateProfileVisibility();
      
      // Actualizar nuevamente después de 500ms (en caso de que la sesión se establezca después de DOMContentLoaded)
      setTimeout(updateProfileVisibility, 500);
      
      existingProfile.dataset.ecEnhanced = '1';
    }

    // NOTA: No inyectamos reportes o documentos ficticios
    // Mantenemos la estructura original de la página intacta
  });

  // ==================== MONITOREAR CAMBIOS DE AUTENTICACIÓN ====================
  // Mantener sincronizado el localStorage con el estado de autenticación de Firebase
  if (typeof onAuthStateChanged === 'function' && window.firebaseAuth) {
    onAuthStateChanged(window.firebaseAuth, (user) => {
      if (user) {
        // Usuario autenticado - guardar en localStorage y en variables globales
        const sessionUser = {
          uid: user.uid,
          email: user.email || '',
          name: user.displayName || '',
          avatarUrl: user.photoURL || ''
        };
        
        try {
          localStorage.setItem('ecoruta_session', JSON.stringify(sessionUser));
          localStorage.setItem('ecoruta_logged_in', 'true');
          window.currentUser = sessionUser;
          window.isLoggedIn = true;
          console.log('Sesión sincronizada desde Firebase:', user.email);
        } catch (e) {
          console.error('Error al sincronizar sesión:', e);
        }
      } else {
        // Usuario no autenticado - limpiar localStorage y variables globales
        try {
          localStorage.removeItem('ecoruta_session');
          localStorage.removeItem('ecoruta_logged_in');
          window.currentUser = null;
          window.isLoggedIn = false;
          console.log('Sesión cerrada');
        } catch (e) {
          console.error('Error al limpiar sesión:', e);
        }
      }
    });
  }
})();
